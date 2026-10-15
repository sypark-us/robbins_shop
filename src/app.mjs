// Application: wires the database, sessions, storefront, checkout/payment, accounts and admin into one HTTP handler.
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import { Router, HttpError, parseCookies, serializeCookie, parseBody, readBody, html, json, redirect, send, mimeFor, safeImageType } from './http.mjs';
import { hashPassword, verifyPassword, randomId, sign, unsign, RateLimiter, validEmail } from './auth.mjs';
import { computeTotals, cartProblems, clampQty, parsePrice } from './cart.mjs';
import { StripeClient, constructWebhookEvent } from './stripe.mjs';
import { layout, esc, attr, nl2br, money, condLabel, imgUrl, productCard, pagination, orderStatusBadge, orderSummaryTable, addressBlock, fmtDate, trustStrip, conditionPill, ICONS } from './render.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SESSION_COOKIE = 'rs_session';
const MAX_IMAGES = 8;

export function createApp(opts = {}) {
  const dataDir = resolve(opts.dataDir || process.env.DATA_DIR || 'data');
  const uploadsDir = join(dataDir, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const conn = db.openDb(opts.dbPath || join(dataDir, 'shop.db'));
  const env = { ...process.env, ...(opts.env || {}) };
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const loginLimiter = new RateLimiter(20, 15 * 60 * 1000);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  // Seed admin from environment on first run
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && !db.adminExists(conn)) {
    db.createUser(conn, { email: env.ADMIN_EMAIL, passwordHash: hashPassword(env.ADMIN_PASSWORD), name: 'Admin', role: 'admin' });
    log(`Created admin account ${env.ADMIN_EMAIL}`);
  }

  const settings = () => {
    const s = db.allSettings(conn);
    if (env.STRIPE_SECRET_KEY) s.stripe_secret_key = env.STRIPE_SECRET_KEY;
    if (env.STRIPE_WEBHOOK_SECRET) s.stripe_webhook_secret = env.STRIPE_WEBHOOK_SECRET;
    if (env.BASE_URL) s.base_url = env.BASE_URL;
    return s;
  };
  const sessionSecret = () => env.SESSION_SECRET || db.getSetting(conn, 'session_secret');
  const stripeFor = (s) => (s.stripe_secret_key ? new StripeClient(s.stripe_secret_key, { fetchImpl }) : null);
  const baseUrlFor = (req, s) => s.base_url || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`;

  // ---------- context / session ----------
  function buildContext(req, res) {
    const url = new URL(req.url, 'http://x');
    const cookies = parseCookies(req.headers.cookie);
    const secret = sessionSecret();
    let sid = unsign(cookies[SESSION_COOKIE], secret);
    let session = sid ? db.loadSession(conn, sid) : null;
    let fresh = false;
    if (!session) { session = { id: randomId(), userId: null, data: {} }; fresh = true; }
    if (!session.data.csrf) { session.data.csrf = randomId(16); fresh = true; }
    const flash = session.data.flash || null;
    if (flash) { delete session.data.flash; fresh = true; }
    const ctx = {
      req, res, url, query: Object.fromEntries(url.searchParams), session, settings: settings(),
      user: session.userId ? db.findUserById(conn, session.userId) : null, flash, csrf: session.data.csrf,
      cartCount: 0, categories: db.listCategories(conn), q: url.searchParams.get('q') || '', dirty: fresh,
      setFlash(type, message) { session.data.flash = { type, message }; ctx.dirty = true; },
      login(user) { session.userId = user.id; ctx.user = user; session.data.csrf = randomId(16); ctx.csrf = session.data.csrf; ctx.dirty = true; },
      logout() { db.deleteSession(conn, session.id); session.userId = null; ctx.user = null; ctx.dirty = true; },
    };
    if (ctx.user && ctx.session.userId && !ctx.user) ctx.session.userId = null;
    ctx.cartCount = db.cartCount(conn, session.id);
    ctx.persist = () => {
      if (ctx.dirty || ctx.touch) {
        db.saveSession(conn, session);
        const secure = /^https/.test(ctx.settings.base_url || '') || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, sign(session.id, secret), { maxAge: 60 * 60 * 24 * 30, secure }));
      }
    };
    return ctx;
  }
  const page = (ctx, title, body, extra = {}) => { ctx.persist(); return html(ctx.res, layout({ title, body, ctx, ...extra })); };
  const go = (ctx, location) => { ctx.persist(); return redirect(ctx.res, location); };
  const csrfCheck = (ctx, fields) => { if (!fields || fields._csrf !== ctx.csrf) throw new HttpError(403, 'Invalid or expired form token. Please go back and try again.'); };
  const requireAdmin = (ctx) => {
    if (!db.adminExists(conn)) throw new Redirect('/admin/setup');
    if (!ctx.user) throw new Redirect(`/login?next=${encodeURIComponent(ctx.url.pathname)}`);
    if (ctx.user.role !== 'admin') throw new HttpError(403, 'Admin access only.');
  };
  class Redirect { constructor(to) { this.to = to; } }
  const touch = (ctx) => { ctx.touch = true; };

  const router = new Router();

  // ---------- storefront ----------
  router.get('/', (ctx) => {
    const cur = ctx.settings.currency;
    const featured = db.listProducts(conn, { featured: true, inStock: true, perPage: 4 }).items;
    const latest = db.listProducts(conn, { perPage: 8 }).items;
    const heroImg = (featured[0] || latest[0])?.image;
    const counts = Object.fromEntries(conn.prepare("SELECT category_id, COUNT(*) AS n FROM products WHERE status = 'active' GROUP BY category_id").all().map((r) => [r.category_id, r.n]));
    const catImg = Object.fromEntries(conn.prepare(`SELECT p.category_id, (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY position, id LIMIT 1) AS img
      FROM products p WHERE p.status = 'active' AND p.category_id IS NOT NULL ORDER BY p.featured DESC, p.id DESC`).all().filter((r) => r.img).reverse().map((r) => [r.category_id, r.img]));
    const section = (title, sub, items, more) => `<section class="section"><div class="section-head"><div><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${more ? `<a class="more" href="${more}">View all →</a>` : ''}</div><div class="grid">${items.map((p) => productCard(p, cur, ctx.csrf)).join('')}</div></section>`;
    const body = `
      <section class="hero">
        <div class="hero-text">
          <span class="eyebrow">${esc(ctx.settings.tagline || 'Welcome')}</span>
          <h1>Good gear.<br>Fair prices.<br>Honest condition.</h1>
          <p>Computer parts, pre-loved finds and clothing, each one inspected, photographed and described exactly as it is.</p>
          <div class="hero-cta"><a class="btn primary lg" href="/shop">Shop all products</a><a class="btn lg ghost" href="/shop?cond=used">Browse pre-owned</a></div>
        </div>
        <div class="hero-art"><img src="${attr(imgUrl(heroImg))}" alt=""></div>
      </section>
      ${trustStrip(ctx.settings)}
      ${ctx.categories.length ? `<section class="section"><div class="section-head"><h2>Shop by category</h2></div><div class="cat-grid">${ctx.categories.map((c) => `<a class="cat-tile" href="/shop?cat=${attr(c.slug)}"><img src="${attr(imgUrl(catImg[c.id]))}" alt=""><div><strong>${esc(c.name)}</strong><span>${counts[c.id] || 0} item${counts[c.id] === 1 ? '' : 's'}</span></div></a>`).join('')}</div></section>` : ''}
      ${featured.length ? section('Staff picks', 'Hand-picked favourites from the current stock', featured, '/shop') : ''}
      ${latest.length ? section('New arrivals', 'Fresh stock, added most recently', latest, '/shop') : '<section class="section"><p class="muted">No products yet. ' + (ctx.user?.role === 'admin' ? '<a href="/admin/products/new">Add your first product</a>.' : 'Check back soon!') + '</p></section>'}
      <section class="banner"><div><h2>Looking for something specific?</h2><p>Use the search, or track an order you already placed.</p></div><div class="hero-cta"><a class="btn primary" href="/shop">Search the shop</a><a class="btn ghost" href="/orders/lookup">Track an order</a></div></section>`;
    return page(ctx, '', body);
  });

  router.get('/shop', (ctx) => {
    const q = ctx.query;
    const cond = db.CONDITIONS[q.cond] ? q.cond : '';
    const result = db.listProducts(conn, { q: q.q?.trim(), category: q.cat, condition: cond, sort: q.sort, page: Number(q.page) || 1, perPage: 24 });
    const cat = q.cat ? db.findCategoryBySlug(conn, q.cat) : null;
    const href = (p) => { const u = new URLSearchParams({ ...q, page: String(p) }); return `/shop?${u}`; };
    const hidden = (except) => Object.entries(q).filter(([k, v]) => k !== except && k !== 'page' && v).map(([k, v]) => `<input type="hidden" name="${attr(k)}" value="${attr(v)}">`).join('');
    const body = `
      <nav class="crumbs"><a href="/">Home</a> › ${cat ? `<a href="/shop">Shop</a> › ${esc(cat.name)}` : 'Shop'}</nav>
      <div class="shop-head"><h1>${cat ? esc(cat.name) : q.q ? `Results for “${esc(q.q)}”` : 'All products'}</h1><span class="muted">${result.total} item${result.total === 1 ? '' : 's'}</span></div>
      <div class="filters">
        <form method="get" action="/shop">${hidden('cat')}<select name="cat" onchange="this.form.submit()"><option value="">All categories</option>${ctx.categories.map((c) => `<option value="${attr(c.slug)}"${c.slug === q.cat ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></form>
        <form method="get" action="/shop">${hidden('cond')}<select name="cond" onchange="this.form.submit()"><option value="">Any condition</option>${Object.entries(db.CONDITIONS).map(([k, v]) => `<option value="${k}"${k === cond ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></form>
        <form method="get" action="/shop">${hidden('sort')}<select name="sort" onchange="this.form.submit()">${[['', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['name', 'Name A–Z']].map(([k, v]) => `<option value="${k}"${(q.sort || '') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></form>
        ${Object.values(q).some(Boolean) ? '<a href="/shop" class="muted">Clear</a>' : ''}
      </div>
      ${result.items.length ? `<div class="grid">${result.items.map((p) => productCard(p, ctx.settings.currency, ctx.csrf)).join('')}</div>` : '<div class="empty"><h2>Nothing matched</h2><p class="muted">Try another search or category.</p><a class="btn" href="/shop">Clear filters</a></div>'}
      ${pagination(result.page, result.pages, href)}`;
    return page(ctx, cat ? cat.name : 'Shop', body);
  });

  router.get('/p/:slug', (ctx, params) => {
    const p = db.getProductBySlug(conn, params.slug);
    if (!p || (p.status !== 'active' && ctx.user?.role !== 'admin')) throw new HttpError(404, 'Product not found');
    const cur = ctx.settings.currency;
    const imgs = p.images.length ? p.images : [{ filename: null }];
    const sale = p.compare_price_cents > p.price_cents;
    const related = p.category_id ? db.listProducts(conn, { category: p.category_slug, inStock: true, perPage: 5 }).items.filter((r) => r.id !== p.id).slice(0, 4) : [];
    const freeOver = Number(ctx.settings.free_shipping_over_cents);
    const body = `
      <nav class="crumbs"><a href="/">Home</a> › <a href="/shop">Shop</a>${p.category_name ? ` › <a href="/shop?cat=${attr(p.category_slug)}">${esc(p.category_name)}</a>` : ''} › ${esc(p.name)}</nav>
      <div class="product">
        <div class="gallery">
          <div class="main-img-wrap">${sale ? `<span class="ribbon sale">-${Math.round((1 - p.price_cents / p.compare_price_cents) * 100)}%</span>` : ''}<img id="main-img" src="${attr(imgUrl(imgs[0].filename))}" alt="${attr(p.name)}"></div>
          ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((i, n) => `<img src="${attr(imgUrl(i.filename))}" alt="" data-full="${attr(imgUrl(i.filename))}" class="${n === 0 ? 'active' : ''}">`).join('')}</div>` : ''}
          <section class="description"><h2>About this item</h2><p>${nl2br(p.description) || '<span class="muted">No description provided.</span>'}</p></section>
        </div>
        <aside class="buy-box">
          ${p.status !== 'active' ? '<p class="notice">This product is not published (admin preview).</p>' : ''}
          <div class="card-meta">${p.category_name ? `<a href="/shop?cat=${attr(p.category_slug)}">${esc(p.category_name)}</a>` : ''}${conditionPill(p.condition)}</div>
          <h1>${esc(p.name)}</h1>
          <div class="price big">${money(p.price_cents, cur)}${sale ? ` <s class="compare">${money(p.compare_price_cents, cur)}</s><span class="save">Save ${money(p.compare_price_cents - p.price_cents, cur)}</span>` : ''}</div>
          <div class="avail">${p.stock > 0 ? (p.stock <= 3 ? `<span class="dot low"></span><span class="low">Only ${p.stock} left in stock</span>` : '<span class="dot ok"></span>In stock, ready to ship') : '<span class="dot out"></span><span class="out">Sold out</span>'}</div>
          ${p.stock > 0 && p.status === 'active' ? `<form method="post" action="/cart/add" class="add-form">
            <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${p.id}">
            <label>Qty <input type="number" name="qty" value="1" min="1" max="${p.stock}"></label>
            <button class="btn primary lg" type="submit">${ICONS.cart} Add to cart</button></form>` : `<a class="btn lg block" href="/shop${p.category_slug ? `?cat=${attr(p.category_slug)}` : ''}">See similar items</a>`}
          <ul class="buy-perks">
            <li>${ICONS.shield}Secure checkout with cards, Apple Pay &amp; Google Pay</li>
            <li>${ICONS.truck}${Number.isFinite(freeOver) && freeOver > 0 && ctx.settings.free_shipping_over_cents !== '' ? `Free shipping on orders over ${money(freeOver, cur)}` : 'Flat-rate shipping, tracked'}</li>
            <li>${ICONS.check}Condition: ${esc(condLabel(p.condition))}, inspected before listing</li>
          </ul>
          <dl class="specs">
            <dt>Condition</dt><dd>${esc(condLabel(p.condition))}</dd>
            ${p.sku ? `<dt>SKU</dt><dd>${esc(p.sku)}</dd>` : ''}
            ${p.category_name ? `<dt>Category</dt><dd><a href="/shop?cat=${attr(p.category_slug)}">${esc(p.category_name)}</a></dd>` : ''}
          </dl>
        </aside>
      </div>
      ${related.length ? `<section class="section"><div class="section-head"><h2>You may also like</h2><a class="more" href="/shop?cat=${attr(p.category_slug)}">More in ${esc(p.category_name)} →</a></div><div class="grid">${related.map((r) => productCard(r, cur, ctx.csrf)).join('')}</div></section>` : ''}`;
    return page(ctx, p.name, body, { head: `<meta property="og:title" content="${attr(p.name)}"><meta property="og:image" content="${attr(imgUrl(p.image))}">` });
  });

  // ---------- cart ----------
  router.post('/cart/add', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const p = db.getProduct(conn, Number(fields.product_id));
    if (!p || p.status !== 'active') throw new HttpError(404, 'Product not found');
    const qty = Math.max(1, clampQty(fields.qty || 1));
    const existing = db.getCart(conn, ctx.session.id).find((l) => l.product_id === p.id);
    const want = (existing ? existing.qty : 0) + qty;
    if (want > p.stock) { ctx.setFlash('error', p.stock > 0 ? `Only ${p.stock} of "${p.name}" available.` : `"${p.name}" is sold out.`); return go(ctx, `/p/${p.slug}`); }
    db.addToCart(conn, ctx.session.id, p.id, qty);
    touch(ctx);
    ctx.setFlash('ok', `Added "${p.name}" to your cart.`);
    return go(ctx, '/cart');
  });
  router.post('/cart/update', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const pid = Number(fields.product_id);
    if (fields.remove !== undefined) db.setCartItem(conn, ctx.session.id, pid, 0);
    else {
      const p = db.getProduct(conn, pid);
      if (p) db.setCartItem(conn, ctx.session.id, pid, Math.min(clampQty(fields.qty), p.stock));
    }
    touch(ctx);
    return go(ctx, '/cart');
  });
  router.get('/cart', (ctx) => {
    const lines = db.getCart(conn, ctx.session.id);
    const cur = ctx.settings.currency;
    const totals = computeTotals(lines, ctx.settings);
    const problems = cartProblems(lines);
    const body = lines.length ? `
      <h1>Your cart</h1>
      ${problems.map((p) => `<p class="notice error">${esc(p.message)}</p>`).join('')}
      <div class="cart-layout">
      <table class="cart-table">
        <thead><tr><th>Item</th><th>Qty</th><th class="num">Price</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${lines.map((l) => `<tr>
          <td><div class="item-cell"><img src="${attr(imgUrl(l.image))}" alt=""><div><a href="/p/${attr(l.slug)}">${esc(l.name)}</a><div class="muted small">${esc(condLabel(l.condition))}</div></div></div></td>
          <td><form method="post" action="/cart/update" class="inline"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${l.product_id}"><input type="number" name="qty" value="${l.qty}" min="0" max="${l.stock}" class="qty" onchange="this.form.submit()"></form></td>
          <td class="num">${money(l.price_cents, cur)}</td><td class="num">${money(l.price_cents * l.qty, cur)}</td>
          <td><form method="post" action="/cart/update" class="inline"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${l.product_id}"><button name="remove" class="link danger" aria-label="Remove">✕</button></form></td></tr>`).join('')}</tbody>
      </table>
      <aside class="summary card">
        <div class="row"><span>Subtotal</span><span>${money(totals.subtotal, cur)}</span></div>
        <div class="row"><span>Shipping</span><span>${totals.shipping ? money(totals.shipping, cur) : 'Free'}</span></div>
        ${totals.tax ? `<div class="row"><span>Tax</span><span>${money(totals.tax, cur)}</span></div>` : ''}
        <div class="row total"><span>Total</span><span>${money(totals.total, cur)}</span></div>
        ${Number(ctx.settings.free_shipping_over_cents) > totals.subtotal && totals.shipping ? `<p class="muted small">Free shipping on orders over ${money(Number(ctx.settings.free_shipping_over_cents), cur)}.</p>` : ''}
        ${problems.length ? '<p class="muted small">Fix the issues above to check out.</p>' : `<a href="/checkout" class="btn primary block">Checkout</a>`}
        <a href="/shop" class="btn block">Continue shopping</a>
      </aside></div>` : `<div class="empty"><h1>Your cart is empty</h1><p class="muted">Find something you like and it will show up here.</p><a href="/shop" class="btn primary">Start shopping</a></div>`;
    return page(ctx, 'Cart', body);
  });

  // ---------- checkout ----------
  const checkoutForm = (ctx, lines, totals, values = {}, errors = []) => {
    const cur = ctx.settings.currency;
    const v = (k) => attr(values[k] ?? '');
    const live = !!ctx.settings.stripe_secret_key;
    return `
      <h1>Checkout</h1>
      ${errors.map((e) => `<p class="notice error">${esc(e)}</p>`).join('')}
      <div class="cart-layout">
      <form method="post" action="/checkout" class="checkout-form card">
        <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <h2>Contact</h2>
        <label>Email <input type="email" name="email" required value="${v('email') || attr(ctx.user?.email || '')}"></label>
        <h2>Shipping address</h2>
        <label>Full name <input name="name" required value="${v('name') || attr(ctx.user?.name || '')}"></label>
        <label>Address line 1 <input name="line1" required value="${v('line1')}"></label>
        <label>Address line 2 <input name="line2" value="${v('line2')}"></label>
        <div class="cols cols3">
          <label>City <input name="city" required value="${v('city')}"></label>
          <label>State / Province <input name="state" value="${v('state')}"></label>
          <label>Postal code <input name="postal" required value="${v('postal')}"></label>
        </div>
        <div class="cols">
          <label>Country <input name="country" required value="${v('country') || 'US'}"></label>
          <label>Phone <input name="phone" value="${v('phone')}"></label>
        </div>
        <label>Order notes <textarea name="notes" rows="2">${esc(values.notes || '')}</textarea></label>
        <button class="btn primary block lg" type="submit">${ICONS.shield} ${live ? 'Continue to secure payment' : 'Continue to payment (test mode)'}</button>
        <p class="muted small">${live ? 'You will be redirected to our secure Stripe checkout to pay by card, Apple Pay, Google Pay, Link and other methods.' : 'Stripe is not configured, so a simulated payment page will be shown. No real charge is made.'}</p>
      </form>
      <aside class="summary card">
        <h2>Order summary</h2>
        ${lines.map((l) => `<div class="row"><span>${esc(l.name)} × ${l.qty}</span><span>${money(l.price_cents * l.qty, cur)}</span></div>`).join('')}
        <hr>
        <div class="row"><span>Subtotal</span><span>${money(totals.subtotal, cur)}</span></div>
        <div class="row"><span>Shipping</span><span>${totals.shipping ? money(totals.shipping, cur) : 'Free'}</span></div>
        ${totals.tax ? `<div class="row"><span>Tax</span><span>${money(totals.tax, cur)}</span></div>` : ''}
        <div class="row total"><span>Total</span><span>${money(totals.total, cur)}</span></div>
      </aside></div>`;
  };

  router.get('/checkout', (ctx) => {
    const lines = db.getCart(conn, ctx.session.id);
    if (!lines.length) return go(ctx, '/cart');
    if (cartProblems(lines).length) { ctx.setFlash('error', 'Some items in your cart are unavailable.'); return go(ctx, '/cart'); }
    return page(ctx, 'Checkout', checkoutForm(ctx, lines, computeTotals(lines, ctx.settings)));
  });

  router.post('/checkout', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const lines = db.getCart(conn, ctx.session.id);
    if (!lines.length) return go(ctx, '/cart');
    const errors = [];
    const f = (k, max = 200) => String(fields[k] || '').trim().slice(0, max);
    if (!validEmail(f('email'))) errors.push('Please enter a valid email address.');
    for (const [k, label] of [['name', 'name'], ['line1', 'address'], ['city', 'city'], ['postal', 'postal code'], ['country', 'country']]) if (!f(k)) errors.push(`Please enter your ${label}.`);
    const problems = cartProblems(lines);
    errors.push(...problems.map((p) => p.message));
    const totals = computeTotals(lines, ctx.settings);
    if (errors.length) return page(ctx, 'Checkout', checkoutForm(ctx, lines, totals, fields, errors));
    const address = { name: f('name'), line1: f('line1'), line2: f('line2'), city: f('city'), state: f('state'), postal: f('postal'), country: f('country', 60), phone: f('phone', 40) };
    const s = ctx.settings;
    const stripe = stripeFor(s);
    let order;
    try {
      order = db.createOrder(conn, {
        user_id: ctx.user?.id ?? null, email: f('email').toLowerCase(), name: address.name, subtotal_cents: totals.subtotal, shipping_cents: totals.shipping,
        tax_cents: totals.tax, total_cents: totals.total, currency: s.currency, ship_address: address, payment_provider: stripe ? 'stripe' : 'test',
      }, lines.map((l) => ({ product_id: l.product_id, name: l.name, unit_cents: l.price_cents, qty: l.qty, image: l.image })));
      if (f('notes', 1000)) db.updateOrderStatus(conn, order.id, 'pending', { notes: f('notes', 1000) });
    } catch (e) {
      if (e.code === 'OUT_OF_STOCK') return page(ctx, 'Checkout', checkoutForm(ctx, lines, totals, fields, [e.message]));
      throw e;
    }
    ctx.session.data.lastOrder = order.number; ctx.dirty = true;
    if (!stripe) return go(ctx, `/pay/test/${order.number}`);
    try {
      const base = baseUrlFor(ctx.req, s);
      const sess = await stripe.createCheckoutSession({
        order, baseUrl: base,
        successUrl: `/checkout/success?order=${order.number}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `/checkout/cancel?order=${order.number}`,
      });
      db.setOrderPaymentRef(conn, order.id, sess.id);
      return go(ctx, sess.url);
    } catch (e) {
      log('Stripe session error:', e.message);
      db.cancelOrder(conn, order.id);
      return page(ctx, 'Checkout', checkoutForm(ctx, lines, totals, fields, [`Payment provider error: ${e.message}`]));
    }
  });

  // Test-mode payment page (used when Stripe is not configured)
  router.get('/pay/test/:number', (ctx, params) => {
    if (ctx.settings.stripe_secret_key) throw new HttpError(404);
    const order = db.getOrderByNumber(conn, params.number);
    if (!order || order.status !== 'pending') throw new HttpError(404, 'Order not found or already paid');
    const body = `<div class="pay-test card">
      <h1>Test payment</h1>
      <p class="notice">Stripe keys are not configured, so this is a <strong>simulated</strong> payment. Add STRIPE_SECRET_KEY to accept real payments.</p>
      <p>Order <strong>${esc(order.number)}</strong> · Total <strong>${money(order.total_cents, order.currency)}</strong></p>
      <form method="post" action="/pay/test/${attr(order.number)}"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <label>Card number <input value="4242 4242 4242 4242" readonly></label>
        <div class="cols"><label>Expiry <input value="12/34" readonly></label><label>CVC <input value="123" readonly></label></div>
        <button class="btn primary block" name="outcome" value="paid">Pay ${money(order.total_cents, order.currency)}</button>
        <button class="btn block" name="outcome" value="cancel">Cancel payment</button></form></div>`;
    return page(ctx, 'Test payment', body);
  });
  router.post('/pay/test/:number', async (ctx, params) => {
    if (ctx.settings.stripe_secret_key) throw new HttpError(404);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const order = db.getOrderByNumber(conn, params.number);
    if (!order) throw new HttpError(404);
    if (fields.outcome === 'cancel') { db.cancelOrder(conn, order.id); ctx.setFlash('error', 'Payment cancelled.'); return go(ctx, '/cart'); }
    if (db.markOrderPaid(conn, order.id, `test_${randomId(8)}`)) db.clearCart(conn, ctx.session.id);
    return go(ctx, `/order/${order.number}?thanks=1`);
  });

  router.get('/checkout/success', async (ctx) => {
    const order = db.getOrderByNumber(conn, ctx.query.order || '');
    if (!order) throw new HttpError(404, 'Order not found');
    const stripe = stripeFor(ctx.settings);
    if (order.status === 'pending' && stripe && ctx.query.session_id) {
      try {
        const sess = await stripe.retrieveCheckoutSession(ctx.query.session_id);
        if (sess.metadata?.order_id === String(order.id) && sess.payment_status === 'paid') db.markOrderPaid(conn, order.id, sess.payment_intent || sess.id);
      } catch (e) { log('Stripe verify error:', e.message); }
    }
    if (order.status !== 'pending' || db.getOrderByNumber(conn, order.number).status === 'paid') db.clearCart(conn, ctx.session.id);
    return go(ctx, `/order/${order.number}?thanks=1`);
  });
  router.get('/checkout/cancel', (ctx) => {
    const order = db.getOrderByNumber(conn, ctx.query.order || '');
    if (order && order.status === 'pending' && ctx.session.data.lastOrder === order.number) db.cancelOrder(conn, order.id);
    ctx.setFlash('error', 'Payment was cancelled. Your cart is still here.');
    return go(ctx, '/cart');
  });

  // Stripe webhook: authoritative payment confirmation
  router.post('/webhooks/stripe', async (ctx) => {
    const s = ctx.settings;
    const raw = await readBody(ctx.req, 2 * 1024 * 1024);
    let event;
    try { event = constructWebhookEvent(raw, ctx.req.headers['stripe-signature'], s.stripe_webhook_secret); }
    catch (e) { log('Webhook rejected:', e.message); return send(ctx.res, 400, `Webhook error: ${e.message}`); }
    const obj = event.data?.object || {};
    const orderId = Number(obj.metadata?.order_id);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (orderId && obj.payment_status === 'paid') { if (db.markOrderPaid(conn, orderId, obj.payment_intent || obj.id)) log(`Order ${orderId} paid via webhook`); }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      if (orderId) db.cancelOrder(conn, orderId);
    } else if (event.type === 'charge.refunded') {
      const o = obj.payment_intent ? conn.prepare('SELECT id FROM orders WHERE payment_ref = ?').get(obj.payment_intent) : null;
      if (o) db.updateOrderStatus(conn, o.id, 'refunded');
    }
    return json(ctx.res, { received: true });
  });

  // ---------- order status (customer) ----------
  const canViewOrder = (ctx, order) => ctx.user?.role === 'admin' || (ctx.user && ctx.user.id === order.user_id) || ctx.session.data.lastOrder === order.number
    || (ctx.session.data.viewOrders || []).includes(order.number);
  router.get('/order/:number', (ctx, params) => {
    const order = db.getOrderByNumber(conn, params.number);
    if (!order || !canViewOrder(ctx, order)) throw new HttpError(404, 'Order not found. Use "Track an order" with your order number and email.');
    const body = `
      ${ctx.query.thanks && order.status !== 'pending' ? `<div class="thanks"><h1>Thank you for your order!</h1><p>A confirmation for <strong>${esc(order.number)}</strong> has been recorded for ${esc(order.email)}.</p></div>` : `<h1>Order ${esc(order.number)}</h1>`}
      <p>Status: ${orderStatusBadge(order.status)} · Placed ${esc(fmtDate(order.created_at))}${order.tracking ? ` · Tracking: <strong>${esc(order.tracking)}</strong>` : ''}</p>
      ${order.status === 'pending' ? `<p class="notice">This order is awaiting payment.${order.payment_provider === 'test' ? ` <a href="/pay/test/${attr(order.number)}">Complete test payment</a>` : ''}</p>` : ''}
      <div class="cart-layout">${orderSummaryTable(order)}<aside class="card"><h2>Ships to</h2>${addressBlock(order.ship_address)}</aside></div>`;
    return page(ctx, `Order ${order.number}`, body);
  });
  router.get('/orders/lookup', (ctx) => page(ctx, 'Track an order', `<div class="card narrow"><h1>Track an order</h1>
    <form method="post" action="/orders/lookup"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
    <label>Order number <input name="number" required placeholder="RS-20260101-ABC123"></label>
    <label>Email used at checkout <input type="email" name="email" required></label>
    <button class="btn primary">Find order</button></form></div>`));
  router.post('/orders/lookup', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const order = db.getOrderByNumber(conn, String(fields.number || '').trim().toUpperCase());
    if (!order || order.email !== String(fields.email || '').trim().toLowerCase()) { ctx.setFlash('error', 'No order matched that number and email.'); return go(ctx, '/orders/lookup'); }
    ctx.session.data.viewOrders = [...new Set([...(ctx.session.data.viewOrders || []), order.number])].slice(-20); ctx.dirty = true;
    return go(ctx, `/order/${order.number}`);
  });

  // ---------- accounts ----------
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);
  const authForm = (ctx, mode, values = {}, error = '') => `<div class="card narrow">
    <h1>${mode === 'login' ? 'Log in' : 'Create account'}</h1>
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}
    <form method="post" action="/${mode}${ctx.query.next ? `?next=${encodeURIComponent(ctx.query.next)}` : ''}"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
      ${mode === 'register' ? `<label>Name <input name="name" value="${attr(values.name || '')}"></label>` : ''}
      <label>Email <input type="email" name="email" required value="${attr(values.email || '')}"></label>
      <label>Password <input type="password" name="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
      <button class="btn primary block">${mode === 'login' ? 'Log in' : 'Create account'}</button></form>
    <p class="muted">${mode === 'login' ? `New here? <a href="/register">Create an account</a>` : `Already have an account? <a href="/login">Log in</a>`}</p></div>`;
  router.get('/login', (ctx) => (ctx.user ? go(ctx, '/account') : page(ctx, 'Log in', authForm(ctx, 'login'))));
  router.get('/register', (ctx) => (ctx.user ? go(ctx, '/account') : page(ctx, 'Create account', authForm(ctx, 'register'))));
  router.post('/login', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const ip = ctx.req.socket.remoteAddress || 'ip';
    if (!loginLimiter.hit(`login:${ip}`)) return page(ctx, 'Log in', authForm(ctx, 'login', fields, 'Too many attempts. Try again in a few minutes.'));
    const user = db.findUserByEmail(conn, fields.email || '');
    if (!user || !verifyPassword(fields.password || '', user.password_hash)) return page(ctx, 'Log in', authForm(ctx, 'login', fields, 'Wrong email or password.'));
    loginLimiter.reset(`login:${ip}`);
    ctx.login(user);
    return go(ctx, safeNext(ctx.query.next) || (user.role === 'admin' ? '/admin' : '/account'));
  });
  router.post('/register', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (!validEmail(fields.email || '')) return page(ctx, 'Create account', authForm(ctx, 'register', fields, 'Please enter a valid email.'));
    if (String(fields.password || '').length < 8) return page(ctx, 'Create account', authForm(ctx, 'register', fields, 'Password must be at least 8 characters.'));
    if (db.findUserByEmail(conn, fields.email)) return page(ctx, 'Create account', authForm(ctx, 'register', fields, 'An account with that email already exists.'));
    const user = db.createUser(conn, { email: fields.email, passwordHash: hashPassword(fields.password), name: String(fields.name || '').trim().slice(0, 100) });
    ctx.login(user);
    ctx.setFlash('ok', 'Welcome! Your account is ready.');
    return go(ctx, safeNext(ctx.query.next) || '/account');
  });
  router.post('/logout', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    ctx.logout();
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
    return redirect(ctx.res, '/');
  });
  router.get('/account', (ctx) => {
    if (!ctx.user) return go(ctx, '/login?next=/account');
    const orders = db.listOrders(conn, { user_id: ctx.user.id }).items;
    const body = `<h1>My account</h1><p>${esc(ctx.user.name || '')} &lt;${esc(ctx.user.email)}&gt;</p>
      <h2>Orders</h2>${orders.length ? `<table class="table"><thead><tr><th>Order</th><th>Date</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td><a href="/order/${attr(o.number)}">${esc(o.number)}</a></td><td>${esc(fmtDate(o.created_at))}</td><td>${orderStatusBadge(o.status)}</td><td class="num">${money(o.total_cents, o.currency)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No orders yet.</p>'}`;
    return page(ctx, 'My account', body);
  });

  // ---------- admin ----------
  router.get('/admin/setup', (ctx) => {
    if (db.adminExists(conn)) return go(ctx, '/admin');
    return page(ctx, 'Set up admin', `<div class="card narrow"><h1>Create the admin account</h1><p class="muted">No admin exists yet. This account manages products, orders and settings.</p>
      <form method="post" action="/admin/setup"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
      <label>Shop name <input name="shop_name" value="${attr(ctx.settings.shop_name)}" required></label>
      <label>Admin email <input type="email" name="email" required></label>
      <label>Password <input type="password" name="password" required minlength="8"></label>
      <button class="btn primary block">Create admin</button></form></div>`);
  });
  router.post('/admin/setup', async (ctx) => {
    if (db.adminExists(conn)) return go(ctx, '/admin');
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (!validEmail(fields.email || '') || String(fields.password || '').length < 8) { ctx.setFlash('error', 'Valid email and a password of 8+ characters required.'); return go(ctx, '/admin/setup'); }
    if (db.findUserByEmail(conn, fields.email)) { ctx.setFlash('error', 'That email is already registered. Log in or use another email.'); return go(ctx, '/admin/setup'); }
    if (fields.shop_name?.trim()) db.setSetting(conn, 'shop_name', fields.shop_name.trim().slice(0, 80));
    const user = db.createUser(conn, { email: fields.email, passwordHash: hashPassword(fields.password), name: 'Admin', role: 'admin' });
    ctx.login(user);
    ctx.setFlash('ok', 'Admin account created. Add your first product!');
    return go(ctx, '/admin');
  });

  const adminPage = (ctx, title, body) => page(ctx, title, body, { admin: true });

  router.get('/admin', (ctx) => {
    requireAdmin(ctx);
    db.expirePendingOrders(conn, 120);
    const st = db.salesStats(conn);
    const recent = db.listOrders(conn, { perPage: 8 }).items;
    const cur = ctx.settings.currency;
    const body = `<h1>Dashboard</h1>
      ${!ctx.settings.stripe_secret_key ? '<p class="notice">Payments are in <strong>test mode</strong>. Add your Stripe keys in <a href="/admin/settings">Settings</a> (or env vars) to accept real payments.</p>' : ''}
      <div class="stats">
        <div class="stat"><div class="stat-v">${money(st.revenue, cur)}</div><div class="stat-l">Revenue (paid)</div></div>
        <div class="stat"><div class="stat-v">${st.orders}</div><div class="stat-l">Paid orders</div></div>
        <div class="stat"><div class="stat-v">${st.pendingShip}</div><div class="stat-l">To ship</div></div>
        <div class="stat"><div class="stat-v">${st.products}</div><div class="stat-l">Active products</div></div>
      </div>
      <p><a class="btn primary" href="/admin/products/new">+ Add product</a> <a class="btn" href="/admin/orders?status=paid">Orders to ship</a></p>
      <div class="cols2">
      <section><h2>Recent orders</h2>${recent.length ? `<table class="table"><tbody>${recent.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${esc(o.name)}</td><td>${orderStatusBadge(o.status)}</td><td class="num">${money(o.total_cents, o.currency)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No orders yet.</p>'}</section>
      <section><h2>Low stock</h2>${st.lowStock.length ? `<table class="table"><tbody>${st.lowStock.map((p) => `<tr><td><a href="/admin/products/${p.id}/edit">${esc(p.name)}</a></td><td class="num">${p.stock}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">All stocked.</p>'}</section>
      </div>`;
    return adminPage(ctx, 'Dashboard', body);
  });

  router.get('/admin/products', (ctx) => {
    requireAdmin(ctx);
    const q = ctx.query;
    const r = db.listProducts(conn, { all: true, q: q.q?.trim(), status: q.status, page: Number(q.page) || 1, perPage: 50 });
    const cur = ctx.settings.currency;
    const body = `<div class="shop-head"><h1>Products <span class="muted">(${r.total})</span></h1><a class="btn primary" href="/admin/products/new">+ Add product</a></div>
      <form class="filters" method="get"><input type="search" name="q" placeholder="Search" value="${attr(q.q || '')}"><select name="status"><option value="">All statuses</option>${['active', 'draft', 'archived'].map((s) => `<option${q.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select><button class="btn">Filter</button></form>
      <table class="table"><thead><tr><th></th><th>Name</th><th>Category</th><th>Condition</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.items.map((p) => `<tr><td><img class="mini" src="${attr(imgUrl(p.image))}" alt=""></td><td><a href="/admin/products/${p.id}/edit">${esc(p.name)}</a>${p.featured ? ' ★' : ''}</td><td>${esc(p.category_name || '')}</td><td>${esc(condLabel(p.condition))}</td><td class="num">${money(p.price_cents, cur)}</td><td class="num${p.stock <= 0 ? ' out' : ''}">${p.stock}</td><td>${esc(p.status)}</td>
        <td class="actions"><a href="/p/${attr(p.slug)}" target="_blank">View</a> <form method="post" action="/admin/products/${p.id}/delete" class="inline" onsubmit="return confirm('Delete this product?')"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="link danger">Delete</button></form></td></tr>`).join('')}
      </tbody></table>${pagination(r.page, r.pages, (p) => `/admin/products?${new URLSearchParams({ ...q, page: String(p) })}`)}`;
    return adminPage(ctx, 'Products', body);
  });

  const productForm = (ctx, p = {}, errors = []) => {
    const v = (k) => attr(p[k] ?? '');
    const isNew = !p.id;
    const cur = ctx.settings.currency;
    const toPrice = (c) => (c === null || c === undefined || c === '' ? '' : (Number(c) / 100).toFixed(2));
    return `<h1>${isNew ? 'Add product' : `Edit: ${esc(p.name)}`}</h1>
      ${errors.map((e) => `<p class="notice error">${esc(e)}</p>`).join('')}
      <form method="post" action="${isNew ? '/admin/products' : `/admin/products/${p.id}`}" enctype="multipart/form-data" class="product-form">
        <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <div class="cols2">
        <div class="card">
          <label>Name <input name="name" required maxlength="200" value="${v('name')}"></label>
          <label>Description <textarea name="description" rows="8">${esc(p.description || '')}</textarea></label>
          <div class="cols">
            <label>Price (${esc(cur.toUpperCase())}) <input name="price" required inputmode="decimal" value="${attr(p.price ?? toPrice(p.price_cents))}"></label>
            <label>Compare-at price <input name="compare_price" inputmode="decimal" value="${attr(p.compare_price ?? toPrice(p.compare_price_cents))}" placeholder="optional"></label>
          </div>
          <div class="cols">
            <label>Stock <input type="number" name="stock" min="0" value="${attr(p.stock ?? 1)}"></label>
            <label>SKU <input name="sku" value="${v('sku')}"></label>
          </div>
          <div class="cols">
            <label>Condition <select name="condition">${Object.entries(db.CONDITIONS).map(([k, l]) => `<option value="${k}"${(p.condition || 'new') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            <label>Category <select name="category_id"><option value="">— none —</option>${ctx.categories.map((c) => `<option value="${c.id}"${Number(p.category_id) === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          </div>
          <div class="cols">
            <label>Status <select name="status">${['active', 'draft', 'archived'].map((s) => `<option${(p.status || 'active') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
            <label class="check"><input type="checkbox" name="featured" value="1"${p.featured ? ' checked' : ''}> Featured on home page</label>
          </div>
          ${isNew ? '' : `<label>URL slug <input name="slug" value="${v('slug')}"></label>`}
        </div>
        <div class="card">
          <h2>Photos</h2>
          ${(p.images || []).length ? `<div class="img-grid">${p.images.map((i, n) => `<div class="img-item"><img src="${attr(imgUrl(i.filename))}" alt="">
            <div>${n === 0 ? '<span class="muted small">Main</span>' : `<button class="link" name="make_primary" value="${i.id}" formnovalidate>Make main</button>`} <button class="link danger" name="delete_image" value="${i.id}" formnovalidate>Remove</button></div></div>`).join('')}</div>` : ''}
          <label>Add photos (JPG, PNG, GIF, WebP; up to ${MAX_IMAGES}) <input type="file" name="images[]" accept="image/png,image/jpeg,image/gif,image/webp" multiple id="image-input"></label>
          <div id="image-preview" class="img-grid"></div>
          <p class="muted small">Tip: the first photo is the main one shown in listings.</p>
        </div></div>
        <p><button class="btn primary" type="submit">${isNew ? 'Create product' : 'Save changes'}</button> <a class="btn" href="/admin/products">Cancel</a></p>
      </form>`;
  };
  router.get('/admin/products/new', (ctx) => { requireAdmin(ctx); return adminPage(ctx, 'Add product', productForm(ctx)); });
  router.get('/admin/products/:id/edit', (ctx, params) => {
    requireAdmin(ctx);
    const p = db.getProduct(conn, Number(params.id));
    if (!p) throw new HttpError(404);
    return adminPage(ctx, 'Edit product', productForm(ctx, p));
  });

  function readProductFields(ctx, fields) {
    const errors = [];
    const name = String(fields.name || '').trim().slice(0, 200);
    if (!name) errors.push('Name is required.');
    const price_cents = parsePrice(fields.price, ctx.settings.currency);
    if (price_cents === null) errors.push('Enter a valid price.');
    const compare_price_cents = String(fields.compare_price || '').trim() ? parsePrice(fields.compare_price, ctx.settings.currency) : null;
    if (String(fields.compare_price || '').trim() && compare_price_cents === null) errors.push('Enter a valid compare-at price.');
    const stock = Math.max(0, Math.floor(Number(fields.stock) || 0));
    const condition = db.CONDITIONS[fields.condition] ? fields.condition : 'new';
    const status = ['active', 'draft', 'archived'].includes(fields.status) ? fields.status : 'active';
    const category_id = fields.category_id ? Number(fields.category_id) : null;
    return { errors, data: { name, description: String(fields.description || '').slice(0, 20000), price_cents, compare_price_cents, stock, condition, status, category_id, featured: fields.featured === '1', sku: String(fields.sku || '').trim().slice(0, 64), slug: fields.slug } };
  }
  function saveImages(productId, files) {
    const current = db.listImages(conn, productId).length;
    let saved = 0, rejected = 0;
    for (const f of files) {
      if (current + saved >= MAX_IMAGES) { rejected++; continue; }
      const ext = safeImageType(f.data);
      if (!ext || f.data.length > 12 * 1024 * 1024) { rejected++; continue; }
      const name = `${Date.now().toString(36)}-${randomId(6)}${ext}`;
      writeFileSync(join(uploadsDir, name), f.data);
      db.addImage(conn, productId, name);
      saved++;
    }
    return { saved, rejected };
  }
  const removeFile = (filename) => { try { unlinkSync(join(uploadsDir, basename(filename))); } catch { /* already gone */ } };

  router.post('/admin/products', async (ctx) => {
    requireAdmin(ctx);
    const { fields, files } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const { errors, data } = readProductFields(ctx, fields);
    if (errors.length) return adminPage(ctx, 'Add product', productForm(ctx, fields, errors));
    const p = db.createProduct(conn, data);
    const r = saveImages(p.id, files.filter((f) => f.field === 'images'));
    ctx.setFlash(r.rejected ? 'error' : 'ok', `Product created.${r.rejected ? ` ${r.rejected} image(s) were rejected (unsupported type, too large, or over the limit).` : ''}`);
    return go(ctx, `/admin/products/${p.id}/edit`);
  });
  router.post('/admin/products/:id', async (ctx, params) => {
    requireAdmin(ctx);
    const id = Number(params.id);
    const existing = db.getProduct(conn, id);
    if (!existing) throw new HttpError(404);
    const { fields, files } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (fields.delete_image) {
      const img = db.deleteImage(conn, id, Number(fields.delete_image));
      if (img) removeFile(img.filename);
      return go(ctx, `/admin/products/${id}/edit`);
    }
    if (fields.make_primary) { db.makePrimaryImage(conn, id, Number(fields.make_primary)); return go(ctx, `/admin/products/${id}/edit`); }
    const { errors, data } = readProductFields(ctx, fields);
    if (errors.length) return adminPage(ctx, 'Edit product', productForm(ctx, { ...existing, ...fields, id }, errors));
    db.updateProduct(conn, id, data);
    const r = saveImages(id, files.filter((f) => f.field === 'images'));
    ctx.setFlash(r.rejected ? 'error' : 'ok', `Saved.${r.rejected ? ` ${r.rejected} image(s) were rejected.` : ''}`);
    return go(ctx, `/admin/products/${id}/edit`);
  });
  router.post('/admin/products/:id/delete', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const imgs = db.deleteProduct(conn, Number(params.id));
    for (const i of imgs) removeFile(i.filename);
    ctx.setFlash('ok', 'Product deleted.');
    return go(ctx, '/admin/products');
  });

  router.get('/admin/categories', (ctx) => {
    requireAdmin(ctx);
    const counts = Object.fromEntries(conn.prepare('SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id').all().map((r) => [r.category_id, r.n]));
    const body = `<h1>Categories</h1>
      <form method="post" action="/admin/categories" class="filters"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input name="name" placeholder="New category, e.g. Graphics cards" required maxlength="60"><button class="btn primary">Add</button></form>
      <table class="table"><thead><tr><th>Name</th><th>Slug</th><th class="num">Products</th><th></th></tr></thead><tbody>
      ${ctx.categories.map((c) => `<tr><td>${esc(c.name)}</td><td class="muted">${esc(c.slug)}</td><td class="num">${counts[c.id] || 0}</td><td class="actions"><form method="post" action="/admin/categories/${c.id}/delete" class="inline" onsubmit="return confirm('Delete category? Products keep existing but become uncategorized.')"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="link danger">Delete</button></form></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No categories yet.</td></tr>'}
      </tbody></table>`;
    return adminPage(ctx, 'Categories', body);
  });
  router.post('/admin/categories', async (ctx) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (String(fields.name || '').trim()) db.createCategory(conn, String(fields.name).trim().slice(0, 60));
    return go(ctx, '/admin/categories');
  });
  router.post('/admin/categories/:id/delete', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    db.deleteCategory(conn, Number(params.id));
    return go(ctx, '/admin/categories');
  });

  router.get('/admin/orders', (ctx) => {
    requireAdmin(ctx);
    const q = ctx.query;
    const r = db.listOrders(conn, { status: db.ORDER_STATUSES.includes(q.status) ? q.status : '', q: q.q?.trim(), page: Number(q.page) || 1 });
    const body = `<h1>Orders <span class="muted">(${r.total})</span></h1>
      <form class="filters" method="get"><input type="search" name="q" placeholder="Order #, email or name" value="${attr(q.q || '')}"><select name="status"><option value="">All statuses</option>${db.ORDER_STATUSES.map((s) => `<option${q.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select><button class="btn">Filter</button></form>
      <table class="table"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Status</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>
      ${r.items.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${esc(fmtDate(o.created_at))}</td><td>${esc(o.name)}<div class="muted small">${esc(o.email)}</div></td><td>${o.items.reduce((s, i) => s + i.qty, 0)}</td><td>${orderStatusBadge(o.status)}</td><td class="muted small">${esc(o.payment_provider)}</td><td class="num">${money(o.total_cents, o.currency)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No orders.</td></tr>'}
      </tbody></table>${pagination(r.page, r.pages, (p) => `/admin/orders?${new URLSearchParams({ ...q, page: String(p) })}`)}`;
    return adminPage(ctx, 'Orders', body);
  });
  router.get('/admin/orders/:id', (ctx, params) => {
    requireAdmin(ctx);
    const o = db.getOrder(conn, Number(params.id));
    if (!o) throw new HttpError(404);
    const body = `<h1>Order ${esc(o.number)} ${orderStatusBadge(o.status)}</h1>
      <div class="cols2">
        <div>${orderSummaryTable(o)}
          <p class="muted small">Placed ${esc(fmtDate(o.created_at))}${o.paid_at ? ` · Paid ${esc(fmtDate(o.paid_at))}` : ''}${o.shipped_at ? ` · Shipped ${esc(fmtDate(o.shipped_at))}` : ''}<br>Payment: ${esc(o.payment_provider)}${o.payment_ref ? ` · ref <code>${esc(o.payment_ref)}</code>` : ''}</p>
          ${o.notes ? `<h3>Customer notes</h3><p>${nl2br(o.notes)}</p>` : ''}</div>
        <div class="card">
          <h2>Customer</h2><p>${esc(o.name)}<br><a href="mailto:${attr(o.email)}">${esc(o.email)}</a></p>
          <h2>Ships to</h2>${addressBlock(o.ship_address)}
          <h2>Update</h2>
          <form method="post" action="/admin/orders/${o.id}/status"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
            <label>Status <select name="status">${db.ORDER_STATUSES.map((s) => `<option${o.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
            <label>Tracking number <input name="tracking" value="${attr(o.tracking)}"></label>
            <button class="btn primary block">Save</button></form>
          ${o.payment_provider === 'stripe' && ['paid', 'shipped', 'delivered'].includes(o.status) && o.payment_ref?.startsWith('pi_') ? `<form method="post" action="/admin/orders/${o.id}/refund" onsubmit="return confirm('Refund the full amount via Stripe?')"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="btn block danger">Refund via Stripe</button></form>` : ''}
          <p class="muted small">Cancelling or refunding returns items to stock.</p>
        </div></div>`;
    return adminPage(ctx, `Order ${o.number}`, body);
  });
  router.post('/admin/orders/:id/status', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const id = Number(params.id);
    if (!db.ORDER_STATUSES.includes(fields.status)) throw new HttpError(400, 'Bad status');
    const o = db.getOrder(conn, id);
    if (!o) throw new HttpError(404);
    const tracking = String(fields.tracking || '').trim().slice(0, 100);
    if (fields.status !== o.status) db.updateOrderStatus(conn, id, fields.status, { tracking });
    else conn.prepare('UPDATE orders SET tracking = ? WHERE id = ?').run(tracking, id);
    ctx.setFlash('ok', 'Order updated.');
    return go(ctx, `/admin/orders/${id}`);
  });
  router.post('/admin/orders/:id/refund', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const o = db.getOrder(conn, Number(params.id));
    const stripe = stripeFor(ctx.settings);
    if (!o || !stripe || !o.payment_ref?.startsWith('pi_')) throw new HttpError(400, 'Order cannot be refunded via Stripe');
    try { await stripe.refundPaymentIntent(o.payment_ref); db.updateOrderStatus(conn, o.id, 'refunded'); ctx.setFlash('ok', 'Refund issued.'); }
    catch (e) { ctx.setFlash('error', `Refund failed: ${e.message}`); }
    return go(ctx, `/admin/orders/${o.id}`);
  });

  router.get('/admin/settings', (ctx) => {
    requireAdmin(ctx);
    const s = db.allSettings(conn);
    const envLocked = (k) => (env[k] ? `<span class="muted small">(overridden by ${k} env var)</span>` : '');
    const body = `<h1>Settings</h1>
      <form method="post" action="/admin/settings" class="cols2"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <div class="card"><h2>Shop</h2>
          <label>Shop name <input name="shop_name" value="${attr(s.shop_name)}" required></label>
          <label>Tagline <input name="tagline" value="${attr(s.tagline)}"></label>
          <label>Contact email <input type="email" name="contact_email" value="${attr(s.contact_email)}"></label>
          <label>Currency (ISO code) <input name="currency" value="${attr(s.currency)}" maxlength="3" required></label>
          <label>Sales tax rate (%) <input name="tax_rate" value="${attr(s.tax_rate)}" inputmode="decimal"></label>
          <label>Flat shipping fee <input name="shipping_flat" value="${attr((Number(s.shipping_flat_cents) / 100).toFixed(2))}" inputmode="decimal"></label>
          <label>Free shipping over (blank = never) <input name="free_shipping_over" value="${attr(s.free_shipping_over_cents === '' ? '' : (Number(s.free_shipping_over_cents) / 100).toFixed(2))}" inputmode="decimal"></label>
          <label>Public base URL ${envLocked('BASE_URL')} <input name="base_url" value="${attr(s.base_url)}" placeholder="https://shop.example.com"></label>
        </div>
        <div class="card"><h2>Payments (Stripe)</h2>
          <p class="muted small">Get keys at <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">dashboard.stripe.com/apikeys</a>. Customers pay on Stripe's hosted checkout with cards, Apple Pay, Google Pay, Link and any other methods you enable in your Stripe dashboard.</p>
          <label>Secret key ${envLocked('STRIPE_SECRET_KEY')} <input name="stripe_secret_key" value="${attr(s.stripe_secret_key)}" placeholder="sk_live_... or sk_test_..." autocomplete="off"></label>
          <label>Webhook signing secret ${envLocked('STRIPE_WEBHOOK_SECRET')} <input name="stripe_webhook_secret" value="${attr(s.stripe_webhook_secret)}" placeholder="whsec_..." autocomplete="off"></label>
          <p class="muted small">Webhook endpoint: <code>${esc(baseUrlFor(ctx.req, ctx.settings))}/webhooks/stripe</code><br>Events: checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, charge.refunded</p>
          <p>Status: <strong>${ctx.settings.stripe_secret_key ? 'Live Stripe checkout' : 'Test mode (simulated payments)'}</strong></p>
        </div>
        <p><button class="btn primary">Save settings</button></p>
      </form>`;
    return adminPage(ctx, 'Settings', body);
  });
  router.post('/admin/settings', async (ctx) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const t = (k, max = 200) => String(fields[k] ?? '').trim().slice(0, max);
    db.setSetting(conn, 'shop_name', t('shop_name', 80) || 'Shop');
    db.setSetting(conn, 'tagline', t('tagline'));
    db.setSetting(conn, 'contact_email', t('contact_email'));
    const cur = t('currency', 3).toLowerCase();
    if (/^[a-z]{3}$/.test(cur)) db.setSetting(conn, 'currency', cur);
    const rate = Number(t('tax_rate', 10));
    db.setSetting(conn, 'tax_rate', Number.isFinite(rate) && rate >= 0 && rate < 100 ? String(rate) : '0');
    db.setSetting(conn, 'shipping_flat_cents', String(parsePrice(t('shipping_flat'), cur) ?? 0));
    db.setSetting(conn, 'free_shipping_over_cents', t('free_shipping_over') === '' ? '' : String(parsePrice(t('free_shipping_over'), cur) ?? ''));
    db.setSetting(conn, 'base_url', t('base_url').replace(/\/+$/, ''));
    db.setSetting(conn, 'stripe_secret_key', t('stripe_secret_key'));
    db.setSetting(conn, 'stripe_webhook_secret', t('stripe_webhook_secret'));
    ctx.setFlash('ok', 'Settings saved.');
    return go(ctx, '/admin/settings');
  });

  // ---------- JSON API (read-only) ----------
  router.get('/api/health', (ctx) => json(ctx.res, { ok: true, products: db.salesStats(conn).products, payments: ctx.settings.stripe_secret_key ? 'stripe' : 'test' }));
  router.get('/api/products', (ctx) => {
    const r = db.listProducts(conn, { q: ctx.query.q, category: ctx.query.cat, page: Number(ctx.query.page) || 1, perPage: 50 });
    return json(ctx.res, { ...r, items: r.items.map((p) => ({ id: p.id, slug: p.slug, name: p.name, price_cents: p.price_cents, currency: ctx.settings.currency, condition: p.condition, stock: p.stock, category: p.category_name, image: p.image ? `/uploads/${p.image}` : null, url: `/p/${p.slug}` })) });
  });

  // ---------- static files ----------
  function serveStatic(res, dir, name, cache) {
    const file = join(dir, basename(name));
    if (!name || name.includes('..') || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': statSync(file).size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  // ---------- main handler ----------
  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (path.startsWith('/public/')) return serveStatic(res, PUBLIC_DIR, path.slice(8), 'public, max-age=3600');
    if (path.startsWith('/uploads/')) return serveStatic(res, uploadsDir, decodeURIComponent(path.slice(9)), 'public, max-age=31536000, immutable');
    if (path === '/webhooks/stripe') {
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      return router.match('POST', path).handler({ req, res, settings: settings() });
    }
    const m = router.match(req.method, path);
    if (!m) return html(res, errorPage('Page not found', 'The page you were looking for does not exist.', settings()), 404);
    let ctx;
    try {
      ctx = buildContext(req, res);
      await m.handler(ctx, m.params);
    } catch (e) {
      if (e instanceof Redirect) return go(ctx, e.to);
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('Error:', e.stack || e);
      if (res.headersSent) return res.end();
      return html(res, errorPage(status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : status === 413 ? 'Upload too large' : 'Something went wrong',
        status === 500 ? 'An unexpected error occurred. Please try again.' : e.message, settings()), status);
    }
  }
  const errorPage = (title, message, s) => layout({ title, body: `<div class="card narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p><a class="btn" href="/">Back to shop</a></div>`, ctx: { settings: s, categories: [], csrf: '' } });

  const sweeper = setInterval(() => { try { db.expirePendingOrders(conn, 120); db.purgeOldSessions(conn, 30); } catch (e) { log('sweep error', e); } }, 10 * 60 * 1000);
  sweeper.unref?.();

  return {
    handler, db: conn, uploadsDir, dataDir,
    close() { clearInterval(sweeper); conn.close(); },
  };
}
