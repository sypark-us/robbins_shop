// HTML rendering helpers: escaping, layout, small components. All user-facing text goes through ctx.t().
import { formatMoney, convertMinor } from './cart.mjs';
import { statSync } from 'node:fs';
import { t as translate, localeFor, LANGS } from './i18n.mjs';

// Cache-busting token for /public assets: changes whenever the CSS or JS file changes.
const assetVersion = (() => { try { const dir = new URL('../public/', import.meta.url); return Math.floor(Math.max(statSync(new URL('style.css', dir)).mtimeMs, statSync(new URL('app.js', dir)).mtimeMs) / 1000).toString(36); } catch { return '1'; } })();
export const asset = (path) => path + '?v=' + assetVersion;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');
export const money = (cents, currency, lang = 'en') => formatMoney(cents, currency, localeFor(lang));
/** Formats an amount for the visitor: converts base-currency amounts into the chosen display currency when one is active. */
export function fmtMoney(ctx, cents, currency = ctx.settings.currency) {
  const base = ctx.settings.currency, display = ctx.display || base, rate = Number(ctx.settings.fx_rate);
  if (currency === base && display !== base && rate > 0) return formatMoney(convertMinor(cents, base, display, rate), display, localeFor(ctx.lang || 'en'));
  return formatMoney(cents, currency, localeFor(ctx.lang || 'en'));
}
export const converting = (ctx) => !!ctx.display && ctx.display !== ctx.settings.currency && Number(ctx.settings.fx_rate) > 0;
export const imgUrl = (filename) => (filename ? `/uploads/${encodeURIComponent(filename)}` : '/public/placeholder.svg');
export const fmtDate = (iso, lang = 'en') => (iso ? new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString(localeFor(lang), { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const condLabel = (c, lang = 'en') => translate(lang, `cond.${c}`);
export const statusLabel = (s, lang = 'en') => translate(lang, `status.${s}`);

// Localized product / category content with English fallback.
export const pName = (p, lang) => (lang === 'ko' && p.name_ko ? p.name_ko : p.name);
export const pDesc = (p, lang) => (lang === 'ko' && p.description_ko ? p.description_ko : p.description);
export const cName = (c, lang) => (c ? (lang === 'ko' && c.name_ko ? c.name_ko : c.name) : '');
export const tagline = (s, lang) => (lang === 'ko' && s.tagline_ko ? s.tagline_ko : s.tagline || '');
export const pCat = (p, lang) => (p.category_name ? (lang === 'ko' && p.category_name_ko ? p.category_name_ko : p.category_name) : '');

export const ICONS = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.9a1 1 0 0 0 1-.8L21 8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3L15.5 10"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>',
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M8 10h3.5l2.2 10h8.6l2-7H12.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14.5" cy="24" r="1.6" fill="#fff"/><circle cx="21.5" cy="24" r="1.6" fill="#fff"/></svg>',
};

/** Builds a link to the current page with one query parameter changed. */
function withParam(ctx, key, value) {
  const u = new URL(ctx.url?.href || 'http://x/');
  u.searchParams.set(key, value);
  return u.pathname + u.search;
}

export function layout({ title, body, ctx, admin = false, head = '', wide = false }) {
  const { settings, user, cartCount = 0, flash, csrf } = ctx;
  const lang = ctx.lang || 'en';
  const T = (k, v) => translate(lang, k, v);
  const shop = esc(settings.shop_name || 'Shop');
  const freeOver = Number(settings.free_shipping_over_cents);
  const hasFree = settings.free_shipping_over_cents !== '' && Number.isFinite(freeOver) && freeOver > 0;
  const announce = hasFree ? T('announce.free_over', { amount: fmtMoney(ctx, freeOver) }) : T('announce.secure');
  const nav = admin
    ? `<a href="/admin">${T('nav.dashboard')}</a><a href="/admin/products">${T('nav.products')}</a><a href="/admin/orders">${T('nav.orders')}</a><a href="/admin/categories">${T('nav.categories')}</a><a href="/admin/settings">${T('nav.settings')}</a><a href="/" class="muted">${T('nav.view_shop')}</a>`
    : `<a href="/shop">${T('nav.shop_all')}</a>${ctx.categories?.slice(0, 5).map((c) => `<a href="/shop?cat=${attr(c.slug)}">${esc(cName(c, lang))}</a>`).join('') || ''}<a href="/shop?cond=used">${T('nav.preowned')}</a>`;
  const langSwitch = `<div class="lang-switch" aria-label="${T('nav.language')}">${ICONS.globe}${Object.keys(LANGS).map((l) => `<a href="${attr(withParam(ctx, 'lang', l))}" class="${l === lang ? 'current' : ''}" hreflang="${l}">${l === 'ko' ? '한국어' : 'EN'}</a>`).join('<span class="sep">|</span>')}</div>`;
  const alt = (settings.alt_currency || '').toLowerCase();
  const curSwitch = !admin && alt && alt !== settings.currency && Number(settings.fx_rate) > 0
    ? `<div class="lang-switch cur-switch" aria-label="${T('nav.currency')}">${[settings.currency, alt].map((c) => `<a href="${attr(withParam(ctx, 'cur', c))}" class="${c === (ctx.display || settings.currency) ? 'current' : ''}">${esc(c.toUpperCase())}</a>`).join('<span class="sep">|</span>')}</div>` : '';
  const account = user
    ? `<a href="${user.role === 'admin' ? '/admin' : '/account'}" class="icon-btn" title="${attr(user.name || user.email)}">${ICONS.user}<span class="icon-label">${esc((user.name || user.email).split(/[\s@]/)[0])}</span></a><form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${attr(csrf)}"><button class="link muted small">${T('nav.logout')}</button></form>`
    : `<a href="/login" class="icon-btn">${ICONS.user}<span class="icon-label">${T('nav.account')}</span></a>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · ${settings.shop_name}` : `${settings.shop_name} — ${tagline(settings, lang) || 'Online shop'}`)}</title>
<meta name="description" content="${attr(tagline(settings, lang))}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${asset('/public/style.css')}">
<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">
${head}
</head>
<body class="${admin ? 'admin' : 'store'} lang-${lang}">
${admin ? '' : `<div class="announce">${esc(announce)}</div>`}
<header class="site-header">
  <div class="wrap header-row">
    <a href="/" class="brand">${ICONS.logo}<span>${shop}</span>${admin ? ' <span class="badge">admin</span>' : ''}</a>
    ${admin ? '' : `<form action="/shop" method="get" class="search" role="search">${ICONS.search}<input type="search" name="q" placeholder="${attr(T('nav.search_ph'))}" value="${attr(ctx.q || '')}" aria-label="${attr(T('admin.search'))}"></form>`}
    <div class="header-right">
      ${langSwitch}
      ${curSwitch}
      ${account}
      ${admin ? '' : `<a href="/cart" class="icon-btn cart-link" aria-label="${attr(T('nav.cart'))}">${ICONS.cart}<span class="icon-label">${T('nav.cart')}</span><span class="cart-count">${cartCount}</span></a>`}
    </div>
  </div>
  <nav class="main-nav"><div class="wrap">${nav}</div></nav>
</header>
${flash ? `<div class="flash ${flash.type}"><div class="wrap">${esc(flash.message)}</div></div>` : ''}
<main class="${wide ? 'wide' : 'wrap'}">
${body}
</main>
${admin ? `<footer class="site-footer admin-footer"><div class="wrap">${shop} admin</div></footer>` : `
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-about">
      <a href="/" class="brand light">${ICONS.logo}<span>${shop}</span></a>
      <p>${esc(tagline(settings, lang))}</p>
      <div class="pay-badges" aria-label="${attr(T('footer.pay_methods'))}"><span>Visa</span><span>Mastercard</span><span>Amex</span><span>Apple Pay</span><span>Google Pay</span><span>Link</span></div>
    </div>
    <div><h4>${T('footer.shop')}</h4><a href="/shop">${T('nav.shop_all')}</a>${ctx.categories?.map((c) => `<a href="/shop?cat=${attr(c.slug)}">${esc(cName(c, lang))}</a>`).join('') || ''}<a href="/shop?sort=price_asc">${T('footer.under_budget')}</a></div>
    <div><h4>${T('footer.help')}</h4><a href="/orders/lookup">${T('footer.track')}</a><a href="/account">${T('footer.my_account')}</a><a href="/cart">${T('nav.cart')}</a>${settings.contact_email ? `<a href="mailto:${attr(settings.contact_email)}">${T('footer.contact')}</a>` : ''}</div>
    <div><h4>${T('footer.good_to_know')}</h4><a href="/shop?cond=used">${T('footer.preowned')}</a><a href="/shop?cond=new">${T('footer.new_items')}</a><a href="/shop?cond=for_parts">${T('footer.for_parts')}</a></div>
  </div>
  <div class="wrap footer-bottom"><span>&copy; ${new Date().getFullYear()} ${shop}. ${T('footer.rights')}</span><span>${T('footer.secured')}</span></div>
</footer>`}
<script src="${asset('/public/app.js')}" defer></script>
</body>
</html>`;
}

export const conditionPill = (c, lang) => `<span class="pill pill-${attr(c)}">${esc(condLabel(c, lang))}</span>`;

export function productCard(p, ctx) {
  const lang = ctx.lang, cur = ctx.settings.currency, csrf = ctx.csrf;
  const T = (k, v) => translate(lang, k, v);
  const soldOut = p.stock <= 0;
  const sale = p.compare_price_cents > p.price_cents;
  const pct = sale ? Math.round((1 - p.price_cents / p.compare_price_cents) * 100) : 0;
  const name = pName(p, lang);
  return `<div class="product-card${soldOut ? ' sold-out' : ''}">
    <a class="thumb" href="/p/${attr(p.slug)}"><img src="${attr(imgUrl(p.image))}" alt="${attr(name)}" loading="lazy">
      ${soldOut ? `<span class="ribbon">${T('product.sold_out')}</span>` : sale ? `<span class="ribbon sale">${T('product.sale', { pct })}</span>` : p.featured ? `<span class="ribbon dark">${T('product.staff_pick')}</span>` : ''}</a>
    <div class="card-body">
      <div class="card-meta">${p.category_name ? `<a href="/shop?cat=${attr(p.category_slug)}">${esc(pCat(p, lang))}</a>` : ''}${conditionPill(p.condition, lang)}</div>
      <a class="card-title" href="/p/${attr(p.slug)}">${esc(name)}</a>
      <div class="card-foot">
        <div class="price">${fmtMoney(ctx, p.price_cents)}${sale ? ` <s class="compare">${fmtMoney(ctx, p.compare_price_cents)}</s>` : ''}</div>
        ${!soldOut && csrf ? `<form method="post" action="/cart/add" class="inline"><input type="hidden" name="_csrf" value="${attr(csrf)}"><input type="hidden" name="product_id" value="${p.id}"><input type="hidden" name="qty" value="1"><button class="quick-add" type="submit" aria-label="${attr(T('product.add'))}: ${attr(name)}">${ICONS.cart}<span>${T('product.quick_add')}</span></button></form>` : ''}
      </div>
    </div></div>`;
}

export function pagination(page, pages, makeHref) {
  if (pages <= 1) return '';
  let out = '<nav class="pagination">';
  if (page > 1) out += `<a href="${attr(makeHref(page - 1))}">&laquo;</a>`;
  for (let i = Math.max(1, page - 3); i <= Math.min(pages, page + 3); i++) out += i === page ? `<span class="current">${i}</span>` : `<a href="${attr(makeHref(i))}">${i}</a>`;
  if (page < pages) out += `<a href="${attr(makeHref(page + 1))}">&raquo;</a>`;
  return out + '</nav>';
}

export function orderStatusBadge(status, lang) {
  return `<span class="status status-${attr(status)}">${esc(statusLabel(status, lang))}</span>`;
}

export function trustStrip(ctx) {
  const { settings, lang } = ctx;
  const T = (k, v) => translate(lang, k, v);
  const freeOver = Number(settings.free_shipping_over_cents);
  const ship = settings.free_shipping_over_cents !== '' && Number.isFinite(freeOver) && freeOver > 0 ? T('trust.free_over', { amount: fmtMoney(ctx, freeOver) }) : T('trust.flat');
  return `<section class="trust">
    <div>${ICONS.truck}<div><strong>${T('trust.fast')}</strong><span>${esc(ship)}</span></div></div>
    <div>${ICONS.shield}<div><strong>${T('trust.secure')}</strong><span>${T('trust.secure_sub')}</span></div></div>
    <div>${ICONS.check}<div><strong>${T('trust.honest')}</strong><span>${T('trust.honest_sub')}</span></div></div>
    <div>${ICONS.box}<div><strong>${T('trust.tracking')}</strong><span>${T('trust.tracking_sub')}</span></div></div>
  </section>`;
}

export function orderSummaryTable(order, ctx) {
  const c = order.currency, lang = ctx.lang;
  const T = (k, v) => translate(lang, k, v);
  const m = (cents) => fmtMoney(ctx, cents, c);
  return `<table class="order-items">
    <thead><tr><th>${T('order.item')}</th><th>${T('order.qty')}</th><th class="num">${T('cart.price')}</th><th class="num">${T('cart.total')}</th></tr></thead>
    <tbody>${order.items.map((it) => `<tr><td><div class="item-cell"><img src="${attr(imgUrl(it.image))}" alt=""><span>${esc(it.name)}</span></div></td><td>${it.qty}</td><td class="num">${m(it.unit_cents)}</td><td class="num">${m(it.unit_cents * it.qty)}</td></tr>`).join('')}</tbody>
    <tfoot>
      <tr><td colspan="3" class="num">${T('cart.subtotal')}</td><td class="num">${m(order.subtotal_cents)}</td></tr>
      <tr><td colspan="3" class="num">${T('cart.shipping')}</td><td class="num">${order.shipping_cents ? m(order.shipping_cents) : T('cart.free')}</td></tr>
      ${order.tax_cents ? `<tr><td colspan="3" class="num">${T('cart.tax')}</td><td class="num">${m(order.tax_cents)}</td></tr>` : ''}
      <tr class="total"><td colspan="3" class="num">${T('cart.total')}</td><td class="num">${m(order.total_cents)}</td></tr>
    </tfoot></table>${converting(ctx) && c === ctx.settings.currency ? `<p class="muted small fx-note">${T('money.approx', { alt: ctx.display.toUpperCase(), base: c.toUpperCase() })}</p>` : ''}`;
}

export function addressBlock(a = {}) {
  const lines = [a.name, a.line1, a.line2, [a.city, a.state, a.postal].filter(Boolean).join(', '), a.country, a.phone].filter(Boolean);
  return `<address>${lines.map(esc).join('<br>')}</address>`;
}
