// Application: wires the database, sessions, storefront, checkout/payment, accounts and admin into one HTTP handler.
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import { Router, HttpError, parseCookies, serializeCookie, parseBody, readBody, html, json, redirect, send, mimeFor, safeImageType } from './http.mjs';
import { hashPassword, verifyPassword, randomId, sign, unsign, RateLimiter, validEmail } from './auth.mjs';
import { computeTotals, clampQty, parsePrice } from './cart.mjs';
import { StripeClient, constructWebhookEvent } from './stripe.mjs';
import { t as translate, normalizeLang, LANGS, DEFAULT_LANG } from './i18n.mjs';
import { layout, esc, attr, nl2br, money, condLabel, statusLabel, imgUrl, productCard, pagination, orderStatusBadge, orderSummaryTable, addressBlock, fmtDate, trustStrip, conditionPill, ICONS, pName, pDesc, cName, pCat, tagline, fmtMoney, converting } from './render.mjs';

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
    const sid = unsign(cookies[SESSION_COOKIE], secret);
    let session = sid ? db.loadSession(conn, sid) : null;
    let fresh = false;
    if (!session) { session = { id: randomId(), userId: null, data: {} }; fresh = true; }
    if (!session.data.csrf) { session.data.csrf = randomId(16); fresh = true; }
    const flash = session.data.flash || null;
    if (flash) { delete session.data.flash; fresh = true; }
    const wantLang = url.searchParams.get('lang');
    if (wantLang && LANGS[wantLang] && session.data.lang !== wantLang) { session.data.lang = wantLang; fresh = true; }
    const lang = normalizeLang(session.data.lang || DEFAULT_LANG);
    const s = settings();
    const alt = (s.alt_currency || '').toLowerCase();
    const wantCur = (url.searchParams.get('cur') || '').toLowerCase();
    if (wantCur && [s.currency, alt].includes(wantCur) && session.data.currency !== wantCur) { session.data.currency = wantCur; fresh = true; }
    const display = session.data.currency && [s.currency, alt].includes(session.data.currency) ? session.data.currency : (lang === 'ko' && alt === 'krw' ? alt : s.currency);
    const ctx = {
      req, res, url, query: Object.fromEntries(url.searchParams), session, settings: s, lang, display,
      t: (key, vars) => translate(lang, key, vars),
      user: session.userId ? db.findUserById(conn, session.userId) : null, flash, csrf: session.data.csrf,
      cartCount: 0, categories: db.listCategories(conn), q: url.searchParams.get('q') || '', dirty: fresh,
      setFlash(type, message) { session.data.flash = { type, message }; ctx.dirty = true; },
      login(user) { session.userId = user.id; ctx.user = user; session.data.csrf = randomId(16); ctx.csrf = session.data.csrf; ctx.dirty = true; },
      logout() { db.deleteSession(conn, session.id); session.userId = null; ctx.user = null; ctx.dirty = true; },
    };
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
  const page = (ctx, title, body, extra = {}) => { ctx.persist(); return html(ctx.res, layout({ title, body, ctx, ...extra }), 200, { 'Cache-Control': 'no-store' }); };
  const go = (ctx, location) => { ctx.persist(); return redirect(ctx.res, location); };
  const csrfCheck = (ctx, fields) => { if (!fields || fields._csrf !== ctx.csrf) throw new HttpError(403, ctx.t('err.csrf')); };
  class Redirect { constructor(to) { this.to = to; } }
  const requireAdmin = (ctx) => {
    if (!db.adminExists(conn)) throw new Redirect('/admin/setup');
    if (!ctx.user) throw new Redirect(`/login?next=${encodeURIComponent(ctx.url.pathname)}`);
    if (ctx.user.role !== 'admin') throw new HttpError(403, ctx.t('err.admin_only'));
    ctx.display = ctx.settings.currency; // admin always works in the base currency
  };
  const touch = (ctx) => { ctx.touch = true; };
  const M = (ctx, cents, currency) => fmtMoney(ctx, cents, currency);
  const fxNote = (ctx) => (converting(ctx) ? `<p class="muted small fx-note">${ctx.t('money.approx', { alt: ctx.display.toUpperCase(), base: ctx.settings.currency.toUpperCase() })}</p>` : '');

  // ---------- exchange rate auto-refresh (ECB rates via frankfurter.app, no API key) ----------
  let fxInFlight = false;
  function maybeRefreshRate(s) {
    const alt = (s.alt_currency || '').toLowerCase();
    if (s.fx_auto !== '1' || !alt || alt === s.currency || fxInFlight) return;
    const age = s.fx_updated_at ? Date.now() - Date.parse(s.fx_updated_at) : Infinity;
    if (age < 12 * 60 * 60 * 1000) return;
    fxInFlight = true;
    Promise.resolve().then(() => fetchImpl(`https://api.frankfurter.app/latest?from=${s.currency.toUpperCase()}&to=${alt.toUpperCase()}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { const rate = data?.rates?.[alt.toUpperCase()]; if (rate > 0) { db.setSetting(conn, 'fx_rate', String(rate)); db.setSetting(conn, 'fx_updated_at', new Date().toISOString()); log(`Exchange rate updated: 1 ${s.currency.toUpperCase()} = ${rate} ${alt.toUpperCase()}`); } })
      .catch((e) => { db.setSetting(conn, 'fx_updated_at', new Date().toISOString()); log('Exchange rate refresh failed:', e.message); })
      .finally(() => { fxInFlight = false; });
  }
  const freeOverOf = (s) => { const n = Number(s.free_shipping_over_cents); return s.free_shipping_over_cents !== '' && Number.isFinite(n) && n > 0 ? n : null; };
  /** Stock/availability problems for cart lines, in the visitor's language. */
  const cartProblems = (ctx, lines) => {
    const out = [];
    for (const l of lines) {
      const name = pName(l, ctx.lang);
      if (l.status !== 'active') out.push({ product_id: l.product_id, message: ctx.t('cart.no_longer', { name }) });
      else if (l.qty > l.stock) out.push({ product_id: l.product_id, message: l.stock > 0 ? ctx.t('cart.only_left', { n: l.stock, name }) : ctx.t('cart.sold_out', { name }) });
    }
    return out;
  };

  const router = new Router();

  // ---------- storefront ----------
  router.get('/', (ctx) => {
    const { t, lang } = ctx;
    const featured = db.listProducts(conn, { featured: true, inStock: true, perPage: 4 }).items;
    const latest = db.listProducts(conn, { perPage: 8 }).items;
    const heroImg = (featured[0] || latest[0])?.image;
    const counts = Object.fromEntries(conn.prepare("SELECT category_id, COUNT(*) AS n FROM products WHERE status = 'active' GROUP BY category_id").all().map((r) => [r.category_id, r.n]));
    const catImg = Object.fromEntries(conn.prepare(`SELECT p.category_id, (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY position, id LIMIT 1) AS img
      FROM products p WHERE p.status = 'active' AND p.category_id IS NOT NULL ORDER BY p.featured DESC, p.id DESC`).all().filter((r) => r.img).reverse().map((r) => [r.category_id, r.img]));
    const section = (title, sub, items, more) => `<section class="section"><div class="section-head"><div><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${more ? `<a class="more" href="${more}">${t('home.view_all')}</a>` : ''}</div><div class="grid">${items.map((p) => productCard(p, ctx)).join('')}</div></section>`;
    const body = `
      <section class="hero">
        <div class="hero-text">
          <span class="eyebrow">${esc(tagline(ctx.settings, lang) || ctx.settings.shop_name)}</span>
          <h1>${t('home.h1')}</h1>
          <p>${t('home.p')}</p>
          <div class="hero-cta"><a class="btn primary lg" href="/shop">${t('home.cta_shop')}</a><a class="btn lg ghost" href="/shop?cond=used">${t('home.cta_preowned')}</a></div>
        </div>
        <div class="hero-art"><img src="${attr(imgUrl(heroImg))}" alt=""></div>
      </section>
      ${trustStrip(ctx)}
      ${ctx.categories.length ? `<section class="section"><div class="section-head"><h2>${t('home.by_category')}</h2></div><div class="cat-grid">${ctx.categories.map((c) => `<a class="cat-tile" href="/shop?cat=${attr(c.slug)}"><img src="${attr(imgUrl(catImg[c.id]))}" alt=""><div><strong>${esc(cName(c, lang))}</strong><span>${counts[c.id] === 1 ? t('home.item') : t('home.items', { n: counts[c.id] || 0 })}</span></div></a>`).join('')}</div></section>` : ''}
      ${featured.length ? section(t('home.staff_picks'), t('home.staff_picks_sub'), featured, '/shop') : ''}
      ${latest.length ? section(t('home.new_arrivals'), t('home.new_arrivals_sub'), latest, '/shop') : `<section class="section"><p class="muted">${t('home.no_products')} ${ctx.user?.role === 'admin' ? `<a href="/admin/products/new">${t('home.add_first')}</a>.` : t('home.check_back')}</p></section>`}
      <section class="banner"><div><h2>${t('home.banner_h')}</h2><p>${t('home.banner_p')}</p></div><div class="hero-cta"><a class="btn primary" href="/shop">${t('home.banner_search')}</a><a class="btn ghost" href="/orders/lookup">${t('home.banner_track')}</a></div></section>`;
    return page(ctx, '', body);
  });

  router.get('/shop', (ctx) => {
    const { t, lang } = ctx;
    const q = ctx.query;
    const cond = db.CONDITIONS[q.cond] ? q.cond : '';
    const result = db.listProducts(conn, { q: q.q?.trim(), category: q.cat, condition: cond, sort: q.sort, page: Number(q.page) || 1, perPage: 24 });
    const cat = q.cat ? db.findCategoryBySlug(conn, q.cat) : null;
    const keep = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'lang' && k !== 'cur'));
    const href = (p) => `/shop?${new URLSearchParams({ ...keep, page: String(p) })}`;
    const hidden = (except) => Object.entries(keep).filter(([k, v]) => k !== except && k !== 'page' && v).map(([k, v]) => `<input type="hidden" name="${attr(k)}" value="${attr(v)}">`).join('');
    const body = `
      <nav class="crumbs"><a href="/">${t('shop.home')}</a> › ${cat ? `<a href="/shop">${t('shop.shop')}</a> › ${esc(cName(cat, lang))}` : t('shop.shop')}</nav>
      <div class="shop-head"><h1>${cat ? esc(cName(cat, lang)) : q.q ? t('shop.results_for', { q: esc(q.q) }) : t('shop.all')}</h1><span class="muted">${result.total === 1 ? t('shop.count_one') : t('shop.count', { n: result.total })}</span></div>
      <div class="filters">
        <form method="get" action="/shop">${hidden('cat')}<select name="cat" onchange="this.form.submit()"><option value="">${t('shop.all_categories')}</option>${ctx.categories.map((c) => `<option value="${attr(c.slug)}"${c.slug === q.cat ? ' selected' : ''}>${esc(cName(c, lang))}</option>`).join('')}</select></form>
        <form method="get" action="/shop">${hidden('cond')}<select name="cond" onchange="this.form.submit()"><option value="">${t('shop.any_condition')}</option>${Object.keys(db.CONDITIONS).map((k) => `<option value="${k}"${k === cond ? ' selected' : ''}>${esc(condLabel(k, lang))}</option>`).join('')}</select></form>
        <form method="get" action="/shop">${hidden('sort')}<select name="sort" onchange="this.form.submit()">${[['', 'shop.sort_newest'], ['price_asc', 'shop.sort_price_asc'], ['price_desc', 'shop.sort_price_desc'], ['name', 'shop.sort_name']].map(([k, v]) => `<option value="${k}"${(q.sort || '') === k ? ' selected' : ''}>${t(v)}</option>`).join('')}</select></form>
        ${Object.values(keep).some(Boolean) ? `<a href="/shop" class="muted">${t('shop.clear')}</a>` : ''}
      </div>
      ${result.items.length ? `<div class="grid">${result.items.map((p) => productCard(p, ctx)).join('')}</div>` : `<div class="empty"><h2>${t('shop.nothing')}</h2><p class="muted">${t('shop.try_another')}</p><a class="btn" href="/shop">${t('shop.clear_filters')}</a></div>`}
      ${pagination(result.page, result.pages, href)}`;
    return page(ctx, cat ? cName(cat, lang) : t('shop.shop'), body);
  });

  router.get('/p/:slug', (ctx, params) => {
    const { t, lang } = ctx;
    const p = db.getProductBySlug(conn, params.slug);
    if (!p || (p.status !== 'active' && ctx.user?.role !== 'admin')) throw new HttpError(404, t('err.product_not_found'));
    const name = pName(p, lang), desc = pDesc(p, lang), catName = pCat(p, lang);
    const imgs = p.images.length ? p.images : [{ filename: null }];
    const sale = p.compare_price_cents > p.price_cents;
    const related = p.category_id ? db.listProducts(conn, { category: p.category_slug, inStock: true, perPage: 5 }).items.filter((r) => r.id !== p.id).slice(0, 4) : [];
    const freeOver = freeOverOf(ctx.settings);
    const body = `
      <nav class="crumbs"><a href="/">${t('shop.home')}</a> › <a href="/shop">${t('shop.shop')}</a>${catName ? ` › <a href="/shop?cat=${attr(p.category_slug)}">${esc(catName)}</a>` : ''} › ${esc(name)}</nav>
      <div class="product">
        <div class="gallery">
          <div class="main-img-wrap">${sale ? `<span class="ribbon sale">${t('product.sale', { pct: Math.round((1 - p.price_cents / p.compare_price_cents) * 100) })}</span>` : ''}<img id="main-img" src="${attr(imgUrl(imgs[0].filename))}" alt="${attr(name)}"></div>
          ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((i, n) => `<img src="${attr(imgUrl(i.filename))}" alt="" data-full="${attr(imgUrl(i.filename))}" class="${n === 0 ? 'active' : ''}">`).join('')}</div>` : ''}
          <section class="description"><h2>${t('product.about')}</h2><p>${nl2br(desc) || `<span class="muted">${t('product.no_desc')}</span>`}</p></section>
        </div>
        <aside class="buy-box">
          ${p.status !== 'active' ? `<p class="notice">${t('product.not_published')}</p>` : ''}
          <div class="card-meta">${catName ? `<a href="/shop?cat=${attr(p.category_slug)}">${esc(catName)}</a>` : ''}${conditionPill(p.condition, lang)}</div>
          <h1>${esc(name)}</h1>
          <div class="price big">${M(ctx, p.price_cents)}${sale ? ` <s class="compare">${M(ctx, p.compare_price_cents)}</s><span class="save">${t('product.save', { amount: M(ctx, p.compare_price_cents - p.price_cents) })}</span>` : ''}</div>
          <div class="avail">${p.stock > 0 ? (p.stock <= 3 ? `<span class="dot low"></span><span class="low">${t('product.only_left', { n: p.stock })}</span>` : `<span class="dot ok"></span>${t('product.in_stock')}`) : `<span class="dot out"></span><span class="out">${t('product.sold_out')}</span>`}</div>
          ${p.stock > 0 && p.status === 'active' ? `<form method="post" action="/cart/add" class="add-form">
            <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${p.id}">
            <label>${t('product.qty')} <input type="number" name="qty" value="1" min="1" max="${p.stock}"></label>
            <button class="btn primary lg" type="submit">${ICONS.cart} ${t('product.add')}</button></form>` : `<a class="btn lg block" href="/shop${p.category_slug ? `?cat=${attr(p.category_slug)}` : ''}">${t('product.see_similar')}</a>`}
          <ul class="buy-perks">
            <li>${ICONS.shield}${t('product.perk_secure')}</li>
            <li>${ICONS.truck}${freeOver ? t('product.perk_free', { amount: M(ctx, freeOver) }) : t('product.perk_flat')}</li>
            <li>${ICONS.check}${t('product.perk_condition', { cond: esc(condLabel(p.condition, lang)) })}</li>
          </ul>
          <dl class="specs">
            <dt>${t('product.condition')}</dt><dd>${esc(condLabel(p.condition, lang))}</dd>
            ${p.sku ? `<dt>${t('product.sku')}</dt><dd>${esc(p.sku)}</dd>` : ''}
            ${catName ? `<dt>${t('product.category')}</dt><dd><a href="/shop?cat=${attr(p.category_slug)}">${esc(catName)}</a></dd>` : ''}
          </dl>
        </aside>
      </div>
      ${related.length ? `<section class="section"><div class="section-head"><h2>${t('product.also_like')}</h2><a class="more" href="/shop?cat=${attr(p.category_slug)}">${t('product.more_in', { cat: esc(catName) })}</a></div><div class="grid">${related.map((r) => productCard(r, ctx)).join('')}</div></section>` : ''}`;
    return page(ctx, name, body, { head: `<meta property="og:title" content="${attr(name)}"><meta property="og:image" content="${attr(imgUrl(p.image))}">` });
  });

  // ---------- cart ----------
  router.post('/cart/add', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const p = db.getProduct(conn, Number(fields.product_id));
    if (!p || p.status !== 'active') throw new HttpError(404, ctx.t('err.product_not_found'));
    const name = pName(p, ctx.lang);
    const qty = Math.max(1, clampQty(fields.qty || 1));
    const existing = db.getCart(conn, ctx.session.id).find((l) => l.product_id === p.id);
    const want = (existing ? existing.qty : 0) + qty;
    if (want > p.stock) { ctx.setFlash('error', p.stock > 0 ? ctx.t('cart.only_available', { n: p.stock, name }) : ctx.t('cart.sold_out', { name })); return go(ctx, `/p/${p.slug}`); }
    db.addToCart(conn, ctx.session.id, p.id, qty);
    touch(ctx);
    ctx.setFlash('ok', ctx.t('cart.added', { name }));
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
    const { t, lang } = ctx;
    const lines = db.getCart(conn, ctx.session.id);
    const totals = computeTotals(lines, ctx.settings);
    const problems = cartProblems(ctx, lines);
    const freeOver = freeOverOf(ctx.settings);
    const body = lines.length ? `
      <h1>${t('cart.title')}</h1>
      ${problems.map((p) => `<p class="notice error">${esc(p.message)}</p>`).join('')}
      <div class="cart-layout">
      <table class="cart-table">
        <thead><tr><th>${t('cart.item')}</th><th>${t('cart.qty')}</th><th class="num">${t('cart.price')}</th><th class="num">${t('cart.total')}</th><th></th></tr></thead>
        <tbody>${lines.map((l) => `<tr>
          <td><div class="item-cell"><img src="${attr(imgUrl(l.image))}" alt=""><div><a href="/p/${attr(l.slug)}">${esc(pName(l, lang))}</a><div class="muted small">${esc(condLabel(l.condition, lang))}</div></div></div></td>
          <td><form method="post" action="/cart/update" class="inline"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${l.product_id}"><input type="number" name="qty" value="${l.qty}" min="0" max="${l.stock}" class="qty" onchange="this.form.submit()"></form></td>
          <td class="num">${M(ctx, l.price_cents)}</td><td class="num">${M(ctx, l.price_cents * l.qty)}</td>
          <td><form method="post" action="/cart/update" class="inline"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input type="hidden" name="product_id" value="${l.product_id}"><button name="remove" class="link danger" aria-label="${attr(t('cart.remove'))}">✕</button></form></td></tr>`).join('')}</tbody>
      </table>
      <aside class="summary card">
        <div class="row"><span>${t('cart.subtotal')}</span><span>${M(ctx, totals.subtotal)}</span></div>
        <div class="row"><span>${t('cart.shipping')}</span><span>${totals.shipping ? M(ctx, totals.shipping) : t('cart.free')}</span></div>
        ${totals.tax ? `<div class="row"><span>${t('cart.tax')}</span><span>${M(ctx, totals.tax)}</span></div>` : ''}
        <div class="row total"><span>${t('cart.total')}</span><span>${M(ctx, totals.total)}</span></div>
        ${freeOver && freeOver > totals.subtotal && totals.shipping ? `<p class="muted small">${t('cart.free_note', { amount: M(ctx, freeOver) })}</p>` : ''}
        ${fxNote(ctx)}
        ${problems.length ? `<p class="muted small">${t('cart.fix')}</p>` : `<a href="/checkout" class="btn primary block lg">${t('cart.checkout')}</a>`}
        <a href="/shop" class="btn block">${t('cart.continue')}</a>
      </aside></div>` : `<div class="empty"><h1>${t('cart.empty')}</h1><p class="muted">${t('cart.empty_p')}</p><a href="/shop" class="btn primary">${t('cart.start')}</a></div>`;
    return page(ctx, t('cart.title'), body);
  });

  // ---------- checkout ----------
  const checkoutForm = (ctx, lines, totals, values = {}, errors = []) => {
    const { t, lang } = ctx;
    const v = (k) => attr(values[k] ?? '');
    const live = !!ctx.settings.stripe_secret_key;
    return `
      <h1>${t('checkout.title')}</h1>
      ${errors.map((e) => `<p class="notice error">${esc(e)}</p>`).join('')}
      <div class="cart-layout">
      <form method="post" action="/checkout" class="checkout-form card">
        <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <h2>${t('checkout.contact')}</h2>
        <label>${t('checkout.email')} <input type="email" name="email" required value="${v('email') || attr(ctx.user?.email || '')}"></label>
        <h2>${t('checkout.address')}</h2>
        <label>${t('checkout.name')} <input name="name" required value="${v('name') || attr(ctx.user?.name || '')}"></label>
        <label>${t('checkout.line1')} <input name="line1" required value="${v('line1')}"></label>
        <label>${t('checkout.line2')} <input name="line2" value="${v('line2')}"></label>
        <div class="cols cols3">
          <label>${t('checkout.city')} <input name="city" required value="${v('city')}"></label>
          <label>${t('checkout.state')} <input name="state" value="${v('state')}"></label>
          <label>${t('checkout.postal')} <input name="postal" required value="${v('postal')}"></label>
        </div>
        <div class="cols">
          <label>${t('checkout.country')} <input name="country" required value="${v('country') || (lang === 'ko' ? 'KR' : 'US')}"></label>
          <label>${t('checkout.phone')} <input name="phone" value="${v('phone')}"></label>
        </div>
        <label>${t('checkout.notes')} <textarea name="notes" rows="2">${esc(values.notes || '')}</textarea></label>
        <button class="btn primary block lg" type="submit">${ICONS.shield} ${live ? t('checkout.continue') : t('checkout.continue_test')}</button>
        <p class="muted small">${live ? t('checkout.stripe_note') : t('checkout.test_note')}</p>
      </form>
      <aside class="summary card">
        <h2>${t('checkout.summary')}</h2>
        ${lines.map((l) => `<div class="row"><span>${esc(pName(l, lang))} × ${l.qty}</span><span>${M(ctx, l.price_cents * l.qty)}</span></div>`).join('')}
        <hr>
        <div class="row"><span>${t('cart.subtotal')}</span><span>${M(ctx, totals.subtotal)}</span></div>
        <div class="row"><span>${t('cart.shipping')}</span><span>${totals.shipping ? M(ctx, totals.shipping) : t('cart.free')}</span></div>
        ${totals.tax ? `<div class="row"><span>${t('cart.tax')}</span><span>${M(ctx, totals.tax)}</span></div>` : ''}
        <div class="row total"><span>${t('cart.total')}</span><span>${M(ctx, totals.total)}</span></div>
        ${fxNote(ctx)}
      </aside></div>`;
  };

  router.get('/checkout', (ctx) => {
    const lines = db.getCart(conn, ctx.session.id);
    if (!lines.length) return go(ctx, '/cart');
    if (cartProblems(ctx, lines).length) { ctx.setFlash('error', ctx.t('cart.unavailable')); return go(ctx, '/cart'); }
    return page(ctx, ctx.t('checkout.title'), checkoutForm(ctx, lines, computeTotals(lines, ctx.settings)));
  });

  router.post('/checkout', async (ctx) => {
    const { t } = ctx;
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const lines = db.getCart(conn, ctx.session.id);
    if (!lines.length) return go(ctx, '/cart');
    const errors = [];
    const f = (k, max = 200) => String(fields[k] || '').trim().slice(0, max);
    if (!validEmail(f('email'))) errors.push(t('checkout.valid_email'));
    for (const [k, label] of [['name', 'checkout.f_name'], ['line1', 'checkout.f_address'], ['city', 'checkout.f_city'], ['postal', 'checkout.f_postal'], ['country', 'checkout.f_country']]) if (!f(k)) errors.push(t('checkout.enter', { field: t(label) }));
    errors.push(...cartProblems(ctx, lines).map((p) => p.message));
    const totals = computeTotals(lines, ctx.settings);
    if (errors.length) return page(ctx, t('checkout.title'), checkoutForm(ctx, lines, totals, fields, errors));
    const address = { name: f('name'), line1: f('line1'), line2: f('line2'), city: f('city'), state: f('state'), postal: f('postal'), country: f('country', 60), phone: f('phone', 40) };
    const s = ctx.settings;
    const stripe = stripeFor(s);
    let order;
    try {
      order = db.createOrder(conn, {
        user_id: ctx.user?.id ?? null, email: f('email').toLowerCase(), name: address.name, subtotal_cents: totals.subtotal, shipping_cents: totals.shipping,
        tax_cents: totals.tax, total_cents: totals.total, currency: s.currency, ship_address: address, payment_provider: stripe ? 'stripe' : 'test',
      }, lines.map((l) => ({ product_id: l.product_id, name: pName(l, ctx.lang), unit_cents: l.price_cents, qty: l.qty, image: l.image })));
      if (f('notes', 1000)) db.updateOrderStatus(conn, order.id, 'pending', { notes: f('notes', 1000) });
    } catch (e) {
      if (e.code === 'OUT_OF_STOCK') { const l = lines.find((x) => x.product_id === e.product_id); return page(ctx, t('checkout.title'), checkoutForm(ctx, lines, totals, fields, [t('cart.sold_out', { name: l ? pName(l, ctx.lang) : '' })])); }
      throw e;
    }
    ctx.session.data.lastOrder = order.number; ctx.dirty = true;
    if (!stripe) return go(ctx, `/pay/test/${order.number}`);
    try {
      const base = baseUrlFor(ctx.req, s);
      const sess = await stripe.createCheckoutSession({
        order, baseUrl: base, locale: ctx.lang, shippingLabel: t('misc.shipping_item'), taxLabel: t('misc.tax_item'),
        successUrl: `/checkout/success?order=${order.number}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `/checkout/cancel?order=${order.number}`,
      });
      db.setOrderPaymentRef(conn, order.id, sess.id);
      return go(ctx, sess.url);
    } catch (e) {
      log('Stripe session error:', e.message);
      db.cancelOrder(conn, order.id);
      return page(ctx, t('checkout.title'), checkoutForm(ctx, lines, totals, fields, [t('checkout.provider_error', { msg: e.message })]));
    }
  });

  // Test-mode payment page (used when Stripe is not configured)
  router.get('/pay/test/:number', (ctx, params) => {
    const { t } = ctx;
    if (ctx.settings.stripe_secret_key) throw new HttpError(404);
    const order = db.getOrderByNumber(conn, params.number);
    if (!order || order.status !== 'pending') throw new HttpError(404, t('err.order_paid'));
    const total = money(order.total_cents, order.currency, ctx.lang);
    const body = `<div class="pay-test card">
      <h1>${t('pay.title')}</h1>
      <p class="notice">${t('pay.notice')}</p>
      <p>${t('pay.order')} <strong>${esc(order.number)}</strong> · ${t('pay.total')} <strong>${total}</strong></p>
      <form method="post" action="/pay/test/${attr(order.number)}"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <label>${t('pay.card')} <input value="4242 4242 4242 4242" readonly></label>
        <div class="cols"><label>${t('pay.expiry')} <input value="12/34" readonly></label><label>${t('pay.cvc')} <input value="123" readonly></label></div>
        <button class="btn primary block lg" name="outcome" value="paid">${t('pay.pay', { amount: total })}</button>
        <button class="btn block" name="outcome" value="cancel">${t('pay.cancel')}</button></form></div>`;
    return page(ctx, t('pay.title'), body);
  });
  router.post('/pay/test/:number', async (ctx, params) => {
    if (ctx.settings.stripe_secret_key) throw new HttpError(404);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const order = db.getOrderByNumber(conn, params.number);
    if (!order) throw new HttpError(404);
    if (fields.outcome === 'cancel') { db.cancelOrder(conn, order.id); ctx.setFlash('error', ctx.t('pay.cancelled')); return go(ctx, '/cart'); }
    if (db.markOrderPaid(conn, order.id, `test_${randomId(8)}`)) db.clearCart(conn, ctx.session.id);
    return go(ctx, `/order/${order.number}?thanks=1`);
  });

  router.get('/checkout/success', async (ctx) => {
    const order = db.getOrderByNumber(conn, ctx.query.order || '');
    if (!order) throw new HttpError(404, ctx.t('err.order_not_found'));
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
    ctx.setFlash('error', ctx.t('pay.stripe_cancelled'));
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
    const { t, lang } = ctx;
    const order = db.getOrderByNumber(conn, params.number);
    if (!order || !canViewOrder(ctx, order)) throw new HttpError(404, t('order.not_found'));
    const body = `
      ${ctx.query.thanks && order.status !== 'pending' ? `<div class="thanks"><h1>${t('order.thanks')}</h1><p>${t('order.thanks_p', { number: esc(order.number), email: esc(order.email) })}</p></div>` : `<h1>${t('order.title', { number: esc(order.number) })}</h1>`}
      <p>${t('order.status')}: ${orderStatusBadge(order.status, lang)} · ${t('order.placed')} ${esc(fmtDate(order.created_at, lang))}${order.tracking ? ` · ${t('order.tracking')}: <strong>${esc(order.tracking)}</strong>` : ''}</p>
      ${order.status === 'pending' ? `<p class="notice">${t('order.awaiting')}${order.payment_provider === 'test' ? ` <a href="/pay/test/${attr(order.number)}">${t('order.complete_test')}</a>` : ''}</p>` : ''}
      <div class="cart-layout">${orderSummaryTable(order, ctx)}<aside class="card"><h2>${t('order.ships_to')}</h2>${addressBlock(order.ship_address)}</aside></div>`;
    return page(ctx, t('order.title', { number: order.number }), body);
  });
  router.get('/orders/lookup', (ctx) => page(ctx, ctx.t('order.lookup'), `<div class="card narrow"><h1>${ctx.t('order.lookup')}</h1>
    <form method="post" action="/orders/lookup"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
    <label>${ctx.t('order.number')} <input name="number" required placeholder="RS-20260101-ABC123"></label>
    <label>${ctx.t('order.email_used')} <input type="email" name="email" required></label>
    <button class="btn primary block">${ctx.t('order.find')}</button></form></div>`));
  router.post('/orders/lookup', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const order = db.getOrderByNumber(conn, String(fields.number || '').trim().toUpperCase());
    if (!order || order.email !== String(fields.email || '').trim().toLowerCase()) { ctx.setFlash('error', ctx.t('order.no_match')); return go(ctx, '/orders/lookup'); }
    ctx.session.data.viewOrders = [...new Set([...(ctx.session.data.viewOrders || []), order.number])].slice(-20); ctx.dirty = true;
    return go(ctx, `/order/${order.number}`);
  });

  // ---------- accounts ----------
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);
  const authForm = (ctx, mode, values = {}, error = '') => {
    const { t } = ctx;
    return `<div class="card narrow">
    <h1>${mode === 'login' ? t('auth.login') : t('auth.register')}</h1>
    ${error ? `<p class="notice error">${esc(error)}</p>` : ''}
    <form method="post" action="/${mode}${ctx.query.next ? `?next=${encodeURIComponent(ctx.query.next)}` : ''}"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
      ${mode === 'register' ? `<label>${t('auth.name')} <input name="name" value="${attr(values.name || '')}"></label>` : ''}
      <label>${t('auth.email')} <input type="email" name="email" required value="${attr(values.email || '')}"></label>
      <label>${t('auth.password')} <input type="password" name="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
      <button class="btn primary block">${mode === 'login' ? t('auth.login') : t('auth.register')}</button></form>
    <p class="muted">${mode === 'login' ? `${t('auth.new_here')} <a href="/register">${t('auth.register')}</a>` : `${t('auth.have_account')} <a href="/login">${t('auth.login')}</a>`}</p></div>`;
  };
  router.get('/login', (ctx) => (ctx.user ? go(ctx, '/account') : page(ctx, ctx.t('auth.login'), authForm(ctx, 'login'))));
  router.get('/register', (ctx) => (ctx.user ? go(ctx, '/account') : page(ctx, ctx.t('auth.register'), authForm(ctx, 'register'))));
  router.post('/login', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const ip = ctx.req.socket.remoteAddress || 'ip';
    if (!loginLimiter.hit(`login:${ip}`)) return page(ctx, ctx.t('auth.login'), authForm(ctx, 'login', fields, ctx.t('auth.too_many')));
    const user = db.findUserByEmail(conn, fields.email || '');
    if (!user || !verifyPassword(fields.password || '', user.password_hash)) return page(ctx, ctx.t('auth.login'), authForm(ctx, 'login', fields, ctx.t('auth.wrong')));
    loginLimiter.reset(`login:${ip}`);
    ctx.login(user);
    return go(ctx, safeNext(ctx.query.next) || (user.role === 'admin' ? '/admin' : '/account'));
  });
  router.post('/register', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (!validEmail(fields.email || '')) return page(ctx, ctx.t('auth.register'), authForm(ctx, 'register', fields, ctx.t('auth.valid_email')));
    if (String(fields.password || '').length < 8) return page(ctx, ctx.t('auth.register'), authForm(ctx, 'register', fields, ctx.t('auth.pw_short')));
    if (db.findUserByEmail(conn, fields.email)) return page(ctx, ctx.t('auth.register'), authForm(ctx, 'register', fields, ctx.t('auth.exists')));
    const user = db.createUser(conn, { email: fields.email, passwordHash: hashPassword(fields.password), name: String(fields.name || '').trim().slice(0, 100) });
    ctx.login(user);
    ctx.setFlash('ok', ctx.t('auth.welcome'));
    return go(ctx, safeNext(ctx.query.next) || '/account');
  });
  router.post('/logout', async (ctx) => {
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const lang = ctx.lang;
    ctx.logout();
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
    return redirect(ctx.res, lang === DEFAULT_LANG ? '/' : `/?lang=${lang}`);
  });
  router.get('/account', (ctx) => {
    const { t, lang } = ctx;
    if (!ctx.user) return go(ctx, '/login?next=/account');
    const orders = db.listOrders(conn, { user_id: ctx.user.id }).items;
    const body = `<h1>${t('account.title')}</h1><p>${esc(ctx.user.name || '')} &lt;${esc(ctx.user.email)}&gt;</p>
      <h2>${t('account.orders')}</h2>${orders.length ? `<table class="table"><thead><tr><th>${t('account.order')}</th><th>${t('account.date')}</th><th>${t('account.status')}</th><th class="num">${t('account.total')}</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td><a href="/order/${attr(o.number)}">${esc(o.number)}</a></td><td>${esc(fmtDate(o.created_at, lang))}</td><td>${orderStatusBadge(o.status, lang)}</td><td class="num">${M(ctx, o.total_cents, o.currency)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('account.none')}</p>`}`;
    return page(ctx, t('account.title'), body);
  });

  // ---------- admin ----------
  router.get('/admin/setup', (ctx) => {
    const { t } = ctx;
    if (db.adminExists(conn)) return go(ctx, '/admin');
    return page(ctx, t('admin.setup'), `<div class="card narrow"><h1>${t('admin.setup')}</h1><p class="muted">${t('admin.setup_p')}</p>
      <form method="post" action="/admin/setup"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
      <label>${t('admin.shop_name')} <input name="shop_name" value="${attr(ctx.settings.shop_name)}" required></label>
      <label>${t('admin.admin_email')} <input type="email" name="email" required></label>
      <label>${t('admin.password')} <input type="password" name="password" required minlength="8"></label>
      <button class="btn primary block">${t('admin.create_admin')}</button></form></div>`);
  });
  router.post('/admin/setup', async (ctx) => {
    if (db.adminExists(conn)) return go(ctx, '/admin');
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (!validEmail(fields.email || '') || String(fields.password || '').length < 8) { ctx.setFlash('error', ctx.t('admin.setup_err')); return go(ctx, '/admin/setup'); }
    if (db.findUserByEmail(conn, fields.email)) { ctx.setFlash('error', ctx.t('admin.setup_exists')); return go(ctx, '/admin/setup'); }
    if (fields.shop_name?.trim()) db.setSetting(conn, 'shop_name', fields.shop_name.trim().slice(0, 80));
    const user = db.createUser(conn, { email: fields.email, passwordHash: hashPassword(fields.password), name: 'Admin', role: 'admin' });
    ctx.login(user);
    ctx.setFlash('ok', ctx.t('admin.setup_done'));
    return go(ctx, '/admin');
  });

  const adminPage = (ctx, title, body) => page(ctx, title, body, { admin: true });

  router.get('/admin', (ctx) => {
    requireAdmin(ctx);
    const { t, lang } = ctx;
    db.expirePendingOrders(conn, 120);
    const st = db.salesStats(conn);
    const recent = db.listOrders(conn, { perPage: 8 }).items;
    const body = `<h1>${t('admin.dashboard')}</h1>
      ${!ctx.settings.stripe_secret_key ? `<p class="notice">${t('admin.test_notice')}</p>` : ''}
      <div class="stats">
        <div class="stat"><div class="stat-v">${M(ctx, st.revenue)}</div><div class="stat-l">${t('admin.revenue')}</div></div>
        <div class="stat"><div class="stat-v">${st.orders}</div><div class="stat-l">${t('admin.paid_orders')}</div></div>
        <div class="stat"><div class="stat-v">${st.pendingShip}</div><div class="stat-l">${t('admin.to_ship')}</div></div>
        <div class="stat"><div class="stat-v">${st.products}</div><div class="stat-l">${t('admin.active_products')}</div></div>
      </div>
      <p><a class="btn primary" href="/admin/products/new">${t('admin.add_product')}</a> <a class="btn" href="/admin/orders?status=paid">${t('admin.orders_to_ship')}</a></p>
      <div class="cols2">
      <section><h2>${t('admin.recent_orders')}</h2>${recent.length ? `<table class="table"><tbody>${recent.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${esc(o.name)}</td><td>${orderStatusBadge(o.status, lang)}</td><td class="num">${M(ctx, o.total_cents, o.currency)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('admin.no_orders')}</p>`}</section>
      <section><h2>${t('admin.low_stock')}</h2>${st.lowStock.length ? `<table class="table"><tbody>${st.lowStock.map((p) => `<tr><td><a href="/admin/products/${p.id}/edit">${esc(p.name)}</a></td><td class="num">${p.stock}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('admin.all_stocked')}</p>`}</section>
      </div>`;
    return adminPage(ctx, t('admin.dashboard'), body);
  });

  const PSTATUSES = ['active', 'draft', 'archived'];
  router.get('/admin/products', (ctx) => {
    requireAdmin(ctx);
    const { t, lang } = ctx;
    const q = ctx.query;
    const r = db.listProducts(conn, { all: true, q: q.q?.trim(), status: PSTATUSES.includes(q.status) ? q.status : '', page: Number(q.page) || 1, perPage: 50 });
    const keep = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'lang' && k !== 'cur'));
    const body = `<div class="shop-head"><h1>${t('admin.products')} <span class="muted">(${r.total})</span></h1><a class="btn primary" href="/admin/products/new">${t('admin.add_product')}</a></div>
      <form class="filters" method="get"><input type="search" name="q" placeholder="${attr(t('admin.search'))}" value="${attr(q.q || '')}"><select name="status"><option value="">${t('admin.all_statuses')}</option>${PSTATUSES.map((s) => `<option value="${s}"${q.status === s ? ' selected' : ''}>${t(`pstatus.${s}`)}</option>`).join('')}</select><button class="btn">${t('admin.filter')}</button></form>
      <table class="table"><thead><tr><th></th><th>${t('admin.name')}</th><th>${t('admin.category')}</th><th>${t('admin.condition')}</th><th class="num">${t('admin.price')}</th><th class="num">${t('admin.stock')}</th><th>${t('admin.status')}</th><th></th></tr></thead><tbody>
      ${r.items.map((p) => `<tr><td><img class="mini" src="${attr(imgUrl(p.image))}" alt=""></td><td><a href="/admin/products/${p.id}/edit">${esc(pName(p, lang))}</a>${p.featured ? ' ★' : ''}${lang === 'ko' && p.name_ko ? `<div class="muted small">${esc(p.name)}</div>` : ''}</td><td>${esc(pCat(p, lang))}</td><td>${esc(condLabel(p.condition, lang))}</td><td class="num">${M(ctx, p.price_cents)}</td><td class="num${p.stock <= 0 ? ' out' : ''}">${p.stock}</td><td>${t(`pstatus.${p.status}`)}</td>
        <td class="actions"><a href="/p/${attr(p.slug)}" target="_blank">${t('admin.view')}</a> <form method="post" action="/admin/products/${p.id}/delete" class="inline" onsubmit="return confirm(${JSON.stringify(t('admin.confirm_delete'))})"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="link danger">${t('admin.delete')}</button></form></td></tr>`).join('')}
      </tbody></table>${pagination(r.page, r.pages, (p) => `/admin/products?${new URLSearchParams({ ...keep, page: String(p) })}`)}`;
    return adminPage(ctx, t('admin.products'), body);
  });

  const productForm = (ctx, p = {}, errors = []) => {
    const { t, lang } = ctx;
    const v = (k) => attr(p[k] ?? '');
    const isNew = !p.id;
    const cur = ctx.settings.currency;
    const toPrice = (c) => (c === null || c === undefined || c === '' ? '' : (Number(c) / 100).toFixed(2));
    return `<h1>${isNew ? t('admin.add_product_title') : t('admin.edit_title', { name: esc(p.name) })}</h1>
      ${errors.map((e) => `<p class="notice error">${esc(e)}</p>`).join('')}
      <form method="post" action="${isNew ? '/admin/products' : `/admin/products/${p.id}`}" enctype="multipart/form-data" class="product-form">
        <input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <div class="cols2">
        <div class="card">
          <div class="cols">
            <label>${t('admin.name_en')} <input name="name" required maxlength="200" value="${v('name')}"></label>
            <label>${t('admin.name_ko')} <input name="name_ko" maxlength="200" value="${v('name_ko')}" placeholder="${attr(t('admin.optional_fallback'))}"></label>
          </div>
          <label>${t('admin.description_en')} <textarea name="description" rows="7">${esc(p.description || '')}</textarea></label>
          <label>${t('admin.description_ko')} <textarea name="description_ko" rows="5" placeholder="${attr(t('admin.optional_fallback'))}">${esc(p.description_ko || '')}</textarea></label>
          <div class="cols">
            <label>${t('admin.price_label', { cur: esc(cur.toUpperCase()) })} <input name="price" required inputmode="decimal" value="${attr(p.price ?? toPrice(p.price_cents))}"></label>
            <label>${t('admin.compare')} <input name="compare_price" inputmode="decimal" value="${attr(p.compare_price ?? toPrice(p.compare_price_cents))}" placeholder="${attr(t('admin.optional'))}"></label>
          </div>
          <div class="cols">
            <label>${t('admin.stock')} <input type="number" name="stock" min="0" value="${attr(p.stock ?? 1)}"></label>
            <label>${t('admin.sku')} <input name="sku" value="${v('sku')}"></label>
          </div>
          <div class="cols">
            <label>${t('admin.condition')} <select name="condition">${Object.keys(db.CONDITIONS).map((k) => `<option value="${k}"${(p.condition || 'new') === k ? ' selected' : ''}>${esc(condLabel(k, lang))}</option>`).join('')}</select></label>
            <label>${t('admin.category')} <select name="category_id"><option value="">${t('admin.none')}</option>${ctx.categories.map((c) => `<option value="${c.id}"${Number(p.category_id) === c.id ? ' selected' : ''}>${esc(cName(c, lang))}</option>`).join('')}</select></label>
          </div>
          <div class="cols">
            <label>${t('admin.status')} <select name="status">${PSTATUSES.map((s) => `<option value="${s}"${(p.status || 'active') === s ? ' selected' : ''}>${t(`pstatus.${s}`)}</option>`).join('')}</select></label>
            <label class="check"><input type="checkbox" name="featured" value="1"${p.featured ? ' checked' : ''}> ${t('admin.featured')}</label>
          </div>
          ${isNew ? '' : `<label>${t('admin.slug')} <input name="slug" value="${v('slug')}"></label>`}
        </div>
        <div class="card">
          <h2>${t('admin.photos')}</h2>
          ${(p.images || []).length ? `<div class="img-grid">${p.images.map((i, n) => `<div class="img-item"><img src="${attr(imgUrl(i.filename))}" alt="">
            <div>${n === 0 ? `<span class="muted small">${t('admin.main')}</span>` : `<button class="link" name="make_primary" value="${i.id}" formnovalidate>${t('admin.make_main')}</button>`} <button class="link danger" name="delete_image" value="${i.id}" formnovalidate>${t('admin.remove')}</button></div></div>`).join('')}</div>` : ''}
          <label>${t('admin.add_photos', { n: MAX_IMAGES })} <input type="file" name="images[]" accept="image/png,image/jpeg,image/gif,image/webp" multiple id="image-input"></label>
          <div id="image-preview" class="img-grid"></div>
          <p class="muted small">${t('admin.tip_first')}</p>
        </div></div>
        <p><button class="btn primary" type="submit">${isNew ? t('admin.create') : t('admin.save')}</button> <a class="btn" href="/admin/products">${t('admin.cancel')}</a></p>
      </form>`;
  };
  router.get('/admin/products/new', (ctx) => { requireAdmin(ctx); return adminPage(ctx, ctx.t('admin.add_product_title'), productForm(ctx)); });
  router.get('/admin/products/:id/edit', (ctx, params) => {
    requireAdmin(ctx);
    const p = db.getProduct(conn, Number(params.id));
    if (!p) throw new HttpError(404);
    return adminPage(ctx, ctx.t('admin.edit_title', { name: p.name }), productForm(ctx, p));
  });

  function readProductFields(ctx, fields) {
    const errors = [];
    const name = String(fields.name || '').trim().slice(0, 200);
    if (!name) errors.push(ctx.t('admin.name_required'));
    const price_cents = parsePrice(fields.price, ctx.settings.currency);
    if (price_cents === null) errors.push(ctx.t('admin.valid_price'));
    const compare_price_cents = String(fields.compare_price || '').trim() ? parsePrice(fields.compare_price, ctx.settings.currency) : null;
    if (String(fields.compare_price || '').trim() && compare_price_cents === null) errors.push(ctx.t('admin.valid_compare'));
    const stock = Math.max(0, Math.floor(Number(fields.stock) || 0));
    const condition = db.CONDITIONS[fields.condition] ? fields.condition : 'new';
    const status = PSTATUSES.includes(fields.status) ? fields.status : 'active';
    const category_id = fields.category_id ? Number(fields.category_id) : null;
    return { errors, data: { name, name_ko: String(fields.name_ko || '').trim().slice(0, 200), description: String(fields.description || '').slice(0, 20000), description_ko: String(fields.description_ko || '').slice(0, 20000),
      price_cents, compare_price_cents, stock, condition, status, category_id, featured: fields.featured === '1', sku: String(fields.sku || '').trim().slice(0, 64), slug: fields.slug } };
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
    if (errors.length) return adminPage(ctx, ctx.t('admin.add_product_title'), productForm(ctx, fields, errors));
    const p = db.createProduct(conn, data);
    const r = saveImages(p.id, files.filter((f) => f.field === 'images'));
    ctx.setFlash(r.rejected ? 'error' : 'ok', `${ctx.t('admin.created')}${r.rejected ? ` ${ctx.t('admin.rejected', { n: r.rejected })}` : ''}`);
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
    if (errors.length) return adminPage(ctx, ctx.t('admin.edit_title', { name: existing.name }), productForm(ctx, { ...existing, ...fields, id }, errors));
    db.updateProduct(conn, id, data);
    const r = saveImages(id, files.filter((f) => f.field === 'images'));
    ctx.setFlash(r.rejected ? 'error' : 'ok', `${ctx.t('admin.saved')}${r.rejected ? ` ${ctx.t('admin.rejected', { n: r.rejected })}` : ''}`);
    return go(ctx, `/admin/products/${id}/edit`);
  });
  router.post('/admin/products/:id/delete', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const imgs = db.deleteProduct(conn, Number(params.id));
    for (const i of imgs) removeFile(i.filename);
    ctx.setFlash('ok', ctx.t('admin.deleted'));
    return go(ctx, '/admin/products');
  });

  router.get('/admin/categories', (ctx) => {
    requireAdmin(ctx);
    const { t } = ctx;
    const counts = Object.fromEntries(conn.prepare('SELECT category_id, COUNT(*) AS n FROM products GROUP BY category_id').all().map((r) => [r.category_id, r.n]));
    const body = `<h1>${t('admin.categories')}</h1>
      <form method="post" action="/admin/categories" class="filters"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input name="name" placeholder="${attr(t('admin.new_category_ph'))}" required maxlength="60"><input name="name_ko" placeholder="${attr(t('admin.korean_name_ph'))}" maxlength="60"><button class="btn primary">${t('admin.add')}</button></form>
      <table class="table"><thead><tr><th>${t('admin.name_en')}</th><th>${t('admin.name_ko')}</th><th>${t('admin.slug_col')}</th><th class="num">${t('admin.products_col')}</th><th></th></tr></thead><tbody>
      ${ctx.categories.map((c) => `<tr><form method="post" action="/admin/categories/${c.id}"><td><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><input name="name" value="${attr(c.name)}" required maxlength="60"></td><td><input name="name_ko" value="${attr(c.name_ko || '')}" maxlength="60"></td><td class="muted">${esc(c.slug)}</td><td class="num">${counts[c.id] || 0}</td><td class="actions"><button class="link">${t('admin.update')}</button></form> <form method="post" action="/admin/categories/${c.id}/delete" class="inline" onsubmit="return confirm(${JSON.stringify(t('admin.confirm_delete_cat'))})"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="link danger">${t('admin.delete')}</button></form></td></tr>`).join('') || `<tr><td colspan="5" class="muted">${t('admin.no_categories')}</td></tr>`}
      </tbody></table>`;
    return adminPage(ctx, t('admin.categories'), body);
  });
  router.post('/admin/categories', async (ctx) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (String(fields.name || '').trim()) db.createCategory(conn, String(fields.name).trim().slice(0, 60), String(fields.name_ko || '').slice(0, 60));
    return go(ctx, '/admin/categories');
  });
  router.post('/admin/categories/:id', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    if (String(fields.name || '').trim()) db.updateCategory(conn, Number(params.id), String(fields.name).slice(0, 60), String(fields.name_ko || '').slice(0, 60));
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
    const { t, lang } = ctx;
    const q = ctx.query;
    const r = db.listOrders(conn, { status: db.ORDER_STATUSES.includes(q.status) ? q.status : '', q: q.q?.trim(), page: Number(q.page) || 1 });
    const keep = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'lang' && k !== 'cur'));
    const body = `<h1>${t('admin.orders')} <span class="muted">(${r.total})</span></h1>
      <form class="filters" method="get"><input type="search" name="q" placeholder="${attr(t('admin.search_orders_ph'))}" value="${attr(q.q || '')}"><select name="status"><option value="">${t('admin.all_statuses')}</option>${db.ORDER_STATUSES.map((s) => `<option value="${s}"${q.status === s ? ' selected' : ''}>${esc(statusLabel(s, lang))}</option>`).join('')}</select><button class="btn">${t('admin.filter')}</button></form>
      <table class="table"><thead><tr><th>${t('admin.order')}</th><th>${t('admin.date')}</th><th>${t('admin.customer')}</th><th>${t('admin.items')}</th><th>${t('admin.status')}</th><th>${t('admin.payment')}</th><th class="num">${t('admin.total')}</th></tr></thead><tbody>
      ${r.items.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${esc(fmtDate(o.created_at, lang))}</td><td>${esc(o.name)}<div class="muted small">${esc(o.email)}</div></td><td>${o.items.reduce((s, i) => s + i.qty, 0)}</td><td>${orderStatusBadge(o.status, lang)}</td><td class="muted small">${esc(o.payment_provider)}</td><td class="num">${M(ctx, o.total_cents, o.currency)}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${t('admin.no_orders_list')}</td></tr>`}
      </tbody></table>${pagination(r.page, r.pages, (p) => `/admin/orders?${new URLSearchParams({ ...keep, page: String(p) })}`)}`;
    return adminPage(ctx, t('admin.orders'), body);
  });
  router.get('/admin/orders/:id', (ctx, params) => {
    requireAdmin(ctx);
    const { t, lang } = ctx;
    const o = db.getOrder(conn, Number(params.id));
    if (!o) throw new HttpError(404);
    const body = `<h1>${t('order.title', { number: esc(o.number) })} ${orderStatusBadge(o.status, lang)}</h1>
      <div class="cols2">
        <div>${orderSummaryTable(o, ctx)}
          <p class="muted small">${t('admin.placed')} ${esc(fmtDate(o.created_at, lang))}${o.paid_at ? ` · ${t('admin.paid')} ${esc(fmtDate(o.paid_at, lang))}` : ''}${o.shipped_at ? ` · ${t('admin.shipped')} ${esc(fmtDate(o.shipped_at, lang))}` : ''}<br>${t('admin.payment')}: ${esc(o.payment_provider)}${o.payment_ref ? ` · ${t('admin.ref')} <code>${esc(o.payment_ref)}</code>` : ''}</p>
          ${o.notes ? `<h3>${t('admin.customer_notes')}</h3><p>${nl2br(o.notes)}</p>` : ''}</div>
        <div class="card">
          <h2>${t('admin.customer')}</h2><p>${esc(o.name)}<br><a href="mailto:${attr(o.email)}">${esc(o.email)}</a></p>
          <h2>${t('admin.ships_to')}</h2>${addressBlock(o.ship_address)}
          <h2>${t('admin.update')}</h2>
          <form method="post" action="/admin/orders/${o.id}/status"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
            <label>${t('admin.status')} <select name="status">${db.ORDER_STATUSES.map((s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${esc(statusLabel(s, lang))}</option>`).join('')}</select></label>
            <label>${t('admin.tracking')} <input name="tracking" value="${attr(o.tracking)}"></label>
            <button class="btn primary block">${t('admin.save')}</button></form>
          ${o.payment_provider === 'stripe' && ['paid', 'shipped', 'delivered'].includes(o.status) && o.payment_ref?.startsWith('pi_') ? `<form method="post" action="/admin/orders/${o.id}/refund" onsubmit="return confirm(${JSON.stringify(t('admin.refund_confirm'))})"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}"><button class="btn block danger">${t('admin.refund')}</button></form>` : ''}
          <p class="muted small">${t('admin.cancel_note')}</p>
        </div></div>`;
    return adminPage(ctx, t('order.title', { number: o.number }), body);
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
    ctx.setFlash('ok', ctx.t('admin.order_updated'));
    return go(ctx, `/admin/orders/${id}`);
  });
  router.post('/admin/orders/:id/refund', async (ctx, params) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const o = db.getOrder(conn, Number(params.id));
    const stripe = stripeFor(ctx.settings);
    if (!o || !stripe || !o.payment_ref?.startsWith('pi_')) throw new HttpError(400, ctx.t('admin.cannot_refund'));
    try { await stripe.refundPaymentIntent(o.payment_ref); db.updateOrderStatus(conn, o.id, 'refunded'); ctx.setFlash('ok', ctx.t('admin.refund_ok')); }
    catch (e) { ctx.setFlash('error', ctx.t('admin.refund_fail', { msg: e.message })); }
    return go(ctx, `/admin/orders/${o.id}`);
  });

  router.get('/admin/settings', (ctx) => {
    requireAdmin(ctx);
    const { t } = ctx;
    const s = db.allSettings(conn);
    const envLocked = (k) => (env[k] ? `<span class="muted small">${t('admin.overridden', { k })}</span>` : '');
    const body = `<h1>${t('admin.settings')}</h1>
      <form method="post" action="/admin/settings" class="cols2"><input type="hidden" name="_csrf" value="${attr(ctx.csrf)}">
        <div class="card"><h2>${t('admin.shop_section')}</h2>
          <label>${t('admin.shop_name')} <input name="shop_name" value="${attr(s.shop_name)}" required></label>
          <label>${t('admin.tagline')} <input name="tagline" value="${attr(s.tagline)}"></label>
          <label>${t('admin.tagline_ko')} <input name="tagline_ko" value="${attr(s.tagline_ko)}"></label>
          <label>${t('admin.contact_email')} <input type="email" name="contact_email" value="${attr(s.contact_email)}"></label>
          <label>${t('admin.currency')} <input name="currency" value="${attr(s.currency)}" maxlength="3" required></label>
          <label>${t('admin.tax_rate')} <input name="tax_rate" value="${attr(s.tax_rate)}" inputmode="decimal"></label>
          <label>${t('admin.flat_shipping')} <input name="shipping_flat" value="${attr((Number(s.shipping_flat_cents) / 100).toFixed(2))}" inputmode="decimal"></label>
          <label>${t('admin.free_over')} <input name="free_shipping_over" value="${attr(s.free_shipping_over_cents === '' ? '' : (Number(s.free_shipping_over_cents) / 100).toFixed(2))}" inputmode="decimal"></label>
          <label>${t('admin.base_url')} ${envLocked('BASE_URL')} <input name="base_url" value="${attr(s.base_url)}" placeholder="https://shop.example.com"></label>
          <h2>${t('admin.currency_display')}</h2>
          <p class="muted small">${t('admin.currency_display_help')}</p>
          <label>${t('admin.alt_currency')} <input name="alt_currency" value="${attr(s.alt_currency)}" maxlength="3" placeholder="krw"></label>
          <label>${t('admin.fx_rate', { base: esc(s.currency.toUpperCase()), alt: esc((s.alt_currency || 'KRW').toUpperCase()) })} <input name="fx_rate" value="${attr(s.fx_rate)}" inputmode="decimal" placeholder="1350"></label>
          <label class="check"><input type="checkbox" name="fx_auto" value="1"${s.fx_auto === '1' ? ' checked' : ''}> ${t('admin.fx_auto')}</label>
          <p class="muted small">${s.fx_updated_at ? t('admin.fx_updated', { when: esc(fmtDate(s.fx_updated_at.replace('T', ' ').replace(/\.\d+Z$/, ''), ctx.lang)) }) : t('admin.fx_never')}</p>
        </div>
        <div class="card"><h2>${t('admin.payments')}</h2>
          <p class="muted small">${t('admin.stripe_help')}</p>
          <label>${t('admin.secret_key')} ${envLocked('STRIPE_SECRET_KEY')} <input name="stripe_secret_key" value="${attr(s.stripe_secret_key)}" placeholder="sk_live_... or sk_test_..." autocomplete="off"></label>
          <label>${t('admin.webhook_secret')} ${envLocked('STRIPE_WEBHOOK_SECRET')} <input name="stripe_webhook_secret" value="${attr(s.stripe_webhook_secret)}" placeholder="whsec_..." autocomplete="off"></label>
          <p class="muted small">${t('admin.webhook_endpoint')}: <code>${esc(baseUrlFor(ctx.req, ctx.settings))}/webhooks/stripe</code><br>${t('admin.events')}: checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, charge.refunded</p>
          <p>${t('admin.status_label')}: <strong>${ctx.settings.stripe_secret_key ? t('admin.status_live') : t('admin.status_test')}</strong></p>
        </div>
        <p><button class="btn primary">${t('admin.save_settings')}</button></p>
      </form>`;
    return adminPage(ctx, t('admin.settings'), body);
  });
  router.post('/admin/settings', async (ctx) => {
    requireAdmin(ctx);
    const { fields } = await parseBody(ctx.req);
    csrfCheck(ctx, fields);
    const tx = (k, max = 200) => String(fields[k] ?? '').trim().slice(0, max);
    db.setSetting(conn, 'shop_name', tx('shop_name', 80) || 'Shop');
    db.setSetting(conn, 'tagline', tx('tagline'));
    db.setSetting(conn, 'tagline_ko', tx('tagline_ko'));
    db.setSetting(conn, 'contact_email', tx('contact_email'));
    const cur = tx('currency', 3).toLowerCase();
    if (/^[a-z]{3}$/.test(cur)) db.setSetting(conn, 'currency', cur);
    const rate = Number(tx('tax_rate', 10));
    db.setSetting(conn, 'tax_rate', Number.isFinite(rate) && rate >= 0 && rate < 100 ? String(rate) : '0');
    db.setSetting(conn, 'shipping_flat_cents', String(parsePrice(tx('shipping_flat'), cur) ?? 0));
    db.setSetting(conn, 'free_shipping_over_cents', tx('free_shipping_over') === '' ? '' : String(parsePrice(tx('free_shipping_over'), cur) ?? ''));
    db.setSetting(conn, 'base_url', tx('base_url').replace(/\/+$/, ''));
    const alt = tx('alt_currency', 3).toLowerCase();
    db.setSetting(conn, 'alt_currency', /^[a-z]{3}$/.test(alt) ? alt : '');
    const fxText = String(fields.fx_rate ?? '').trim();
    const fx = Number(fxText.replace(/[^0-9.]/g, ''));
    if (!fxText) db.setSetting(conn, 'fx_rate', '');
    else if (Number.isFinite(fx) && fx > 0 && String(fx) !== db.getSetting(conn, 'fx_rate')) { db.setSetting(conn, 'fx_rate', String(fx)); db.setSetting(conn, 'fx_updated_at', new Date().toISOString()); }
    const autoBefore = db.getSetting(conn, 'fx_auto');
    db.setSetting(conn, 'fx_auto', fields.fx_auto === '1' ? '1' : '0');
    if (fields.fx_auto === '1' && autoBefore !== '1') db.setSetting(conn, 'fx_updated_at', '');
    maybeRefreshRate(settings());
    db.setSetting(conn, 'stripe_secret_key', tx('stripe_secret_key'));
    db.setSetting(conn, 'stripe_webhook_secret', tx('stripe_webhook_secret'));
    ctx.setFlash('ok', ctx.t('admin.settings_saved'));
    return go(ctx, '/admin/settings');
  });

  // ---------- JSON API (read-only) ----------
  router.get('/api/health', (ctx) => json(ctx.res, { ok: true, products: db.salesStats(conn).products, payments: ctx.settings.stripe_secret_key ? 'stripe' : 'test' }));
  router.get('/api/products', (ctx) => {
    const r = db.listProducts(conn, { q: ctx.query.q, category: ctx.query.cat, page: Number(ctx.query.page) || 1, perPage: 50 });
    return json(ctx.res, { ...r, items: r.items.map((p) => ({ id: p.id, slug: p.slug, name: p.name, name_ko: p.name_ko || null, price_cents: p.price_cents, currency: ctx.settings.currency, condition: p.condition, stock: p.stock, category: p.category_name, image: p.image ? `/uploads/${p.image}` : null, url: `/p/${p.slug}` })) });
  });

  // ---------- static files ----------
  function serveStatic(res, dir, name, cache) {
    const file = join(dir, basename(name));
    if (!name || name.includes('..') || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': statSync(file).size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  const errorPage = (title, message, s, lang = DEFAULT_LANG) => layout({ title, body: `<div class="card narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p><a class="btn" href="/">${translate(lang, 'err.back')}</a></div>`, ctx: { settings: s, categories: [], csrf: '', lang } });

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
    let ctx;
    try {
      ctx = buildContext(req, res);
      maybeRefreshRate(ctx.settings);
      if (!m) throw new HttpError(404, ctx.t('err.not_found_p'));
      await m.handler(ctx, m.params);
    } catch (e) {
      if (e instanceof Redirect) return go(ctx, e.to);
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('Error:', e.stack || e);
      if (res.headersSent) return res.end();
      const lang = ctx?.lang || DEFAULT_LANG;
      const T = (k) => translate(lang, k);
      ctx?.persist?.();
      return html(res, errorPage(status === 404 ? T('err.not_found') : status === 403 ? T('err.forbidden') : status === 413 ? T('err.too_large') : T('err.generic'),
        status === 500 ? T('err.generic_p') : e.message, settings(), lang), status, { 'Cache-Control': 'no-store' });
    }
  }

  const sweeper = setInterval(() => { try { db.expirePendingOrders(conn, 120); db.purgeOldSessions(conn, 30); maybeRefreshRate(settings()); } catch (e) { log('sweep error', e); } }, 10 * 60 * 1000);
  sweeper.unref?.();

  return {
    handler, db: conn, uploadsDir, dataDir,
    close() { clearInterval(sweeper); conn.close(); },
  };
}
