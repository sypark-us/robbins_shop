// HTML rendering helpers: escaping, layout, small components.
import { formatMoney } from './cart.mjs';
import { CONDITIONS } from './db.mjs';
import { statSync } from 'node:fs';

// Cache-busting token for /public assets: changes whenever the CSS or JS file changes.
const assetVersion = (() => { try { const dir = new URL('../public/', import.meta.url); return Math.floor(Math.max(statSync(new URL('style.css', dir)).mtimeMs, statSync(new URL('app.js', dir)).mtimeMs) / 1000).toString(36); } catch { return '1'; } })();
export const asset = (path) => path + '?v=' + assetVersion;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');
export const money = (cents, currency) => formatMoney(cents, currency);
export const condLabel = (c) => CONDITIONS[c] || c;
export const imgUrl = (filename) => (filename ? `/uploads/${encodeURIComponent(filename)}` : '/public/placeholder.svg');
export const fmtDate = (iso) => (iso ? new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export const ICONS = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.9a1 1 0 0 0 1-.8L21 8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3L15.5 10"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>',
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M8 10h3.5l2.2 10h8.6l2-7H12.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14.5" cy="24" r="1.6" fill="#fff"/><circle cx="21.5" cy="24" r="1.6" fill="#fff"/></svg>',
};

export function layout({ title, body, ctx, admin = false, head = '', wide = false }) {
  const { settings, user, cartCount = 0, flash, csrf } = ctx;
  const shop = esc(settings.shop_name || 'Shop');
  const freeOver = Number(settings.free_shipping_over_cents);
  const announce = settings.free_shipping_over_cents !== '' && Number.isFinite(freeOver) && freeOver > 0
    ? `Free shipping on orders over ${money(freeOver, settings.currency)}` : 'Secure checkout · Tested & honestly described';
  const nav = admin
    ? `<a href="/admin">Dashboard</a><a href="/admin/products">Products</a><a href="/admin/orders">Orders</a><a href="/admin/categories">Categories</a><a href="/admin/settings">Settings</a><a href="/" class="muted">View shop ↗</a>`
    : `<a href="/shop">All products</a>${ctx.categories?.slice(0, 5).map((c) => `<a href="/shop?cat=${attr(c.slug)}">${esc(c.name)}</a>`).join('') || ''}<a href="/shop?cond=used">Pre-owned</a>`;
  const account = user
    ? `<a href="${user.role === 'admin' ? '/admin' : '/account'}" class="icon-btn" title="${attr(user.name || user.email)}">${ICONS.user}<span class="icon-label">${esc((user.name || user.email).split(/[\s@]/)[0])}</span></a><form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${attr(csrf)}"><button class="link muted small">Log out</button></form>`
    : `<a href="/login" class="icon-btn">${ICONS.user}<span class="icon-label">Account</span></a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · ${settings.shop_name}` : `${settings.shop_name} — ${settings.tagline || 'Online shop'}`)}</title>
<meta name="description" content="${attr(settings.tagline || '')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${asset('/public/style.css')}">
<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">
${head}
</head>
<body class="${admin ? 'admin' : 'store'}">
${admin ? '' : `<div class="announce">${esc(announce)}</div>`}
<header class="site-header">
  <div class="wrap header-row">
    <a href="/" class="brand">${ICONS.logo}<span>${shop}</span>${admin ? ' <span class="badge">admin</span>' : ''}</a>
    ${admin ? '' : `<form action="/shop" method="get" class="search" role="search">${ICONS.search}<input type="search" name="q" placeholder="Search parts, gear, clothing…" value="${attr(ctx.q || '')}" aria-label="Search"></form>`}
    <div class="header-right">
      ${account}
      ${admin ? '' : `<a href="/cart" class="icon-btn cart-link" aria-label="Cart">${ICONS.cart}<span class="icon-label">Cart</span><span class="cart-count">${cartCount}</span></a>`}
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
      <p>${esc(settings.tagline || '')}</p>
      <div class="pay-badges" aria-label="Accepted payment methods"><span>Visa</span><span>Mastercard</span><span>Amex</span><span>Apple Pay</span><span>Google Pay</span><span>Link</span></div>
    </div>
    <div><h4>Shop</h4><a href="/shop">All products</a>${ctx.categories?.map((c) => `<a href="/shop?cat=${attr(c.slug)}">${esc(c.name)}</a>`).join('') || ''}<a href="/shop?sort=price_asc">Under budget</a></div>
    <div><h4>Help</h4><a href="/orders/lookup">Track an order</a><a href="/account">My account</a><a href="/cart">Cart</a>${settings.contact_email ? `<a href="mailto:${attr(settings.contact_email)}">Contact us</a>` : ''}</div>
    <div><h4>Good to know</h4><a href="/shop?cond=used">Pre-owned items</a><a href="/shop?cond=new">New items</a><a href="/shop?cond=for_parts">For parts &amp; repair</a></div>
  </div>
  <div class="wrap footer-bottom"><span>&copy; ${new Date().getFullYear()} ${shop}. All rights reserved.</span><span>Payments secured by Stripe</span></div>
</footer>`}
<script src="${asset('/public/app.js')}" defer></script>
</body>
</html>`;
}

export const conditionPill = (c) => `<span class="pill pill-${attr(c)}">${esc(condLabel(c))}</span>`;

export function productCard(p, currency, csrf) {
  const soldOut = p.stock <= 0;
  const sale = p.compare_price_cents > p.price_cents;
  const pct = sale ? Math.round((1 - p.price_cents / p.compare_price_cents) * 100) : 0;
  return `<div class="product-card${soldOut ? ' sold-out' : ''}">
    <a class="thumb" href="/p/${attr(p.slug)}"><img src="${attr(imgUrl(p.image))}" alt="${attr(p.name)}" loading="lazy">
      ${soldOut ? '<span class="ribbon">Sold out</span>' : sale ? `<span class="ribbon sale">-${pct}%</span>` : p.featured ? '<span class="ribbon dark">Staff pick</span>' : ''}</a>
    <div class="card-body">
      <div class="card-meta">${p.category_name ? `<a href="/shop?cat=${attr(p.category_slug)}">${esc(p.category_name)}</a>` : ''}${conditionPill(p.condition)}</div>
      <a class="card-title" href="/p/${attr(p.slug)}">${esc(p.name)}</a>
      <div class="card-foot">
        <div class="price">${money(p.price_cents, currency)}${sale ? ` <s class="compare">${money(p.compare_price_cents, currency)}</s>` : ''}</div>
        ${!soldOut && csrf ? `<form method="post" action="/cart/add" class="inline"><input type="hidden" name="_csrf" value="${attr(csrf)}"><input type="hidden" name="product_id" value="${p.id}"><input type="hidden" name="qty" value="1"><button class="quick-add" type="submit" aria-label="Add ${attr(p.name)} to cart">${ICONS.cart}<span>Add</span></button></form>` : ''}
      </div>
    </div></div>`;
}

export function pagination(page, pages, makeHref) {
  if (pages <= 1) return '';
  let out = '<nav class="pagination">';
  if (page > 1) out += `<a href="${attr(makeHref(page - 1))}">&laquo; Prev</a>`;
  for (let i = Math.max(1, page - 3); i <= Math.min(pages, page + 3); i++) out += i === page ? `<span class="current">${i}</span>` : `<a href="${attr(makeHref(i))}">${i}</a>`;
  if (page < pages) out += `<a href="${attr(makeHref(page + 1))}">Next &raquo;</a>`;
  return out + '</nav>';
}

export function orderStatusBadge(status) {
  return `<span class="status status-${attr(status)}">${esc(status)}</span>`;
}

export function trustStrip(settings) {
  const freeOver = Number(settings.free_shipping_over_cents);
  const ship = settings.free_shipping_over_cents !== '' && Number.isFinite(freeOver) && freeOver > 0 ? `Free over ${money(freeOver, settings.currency)}` : 'Flat-rate shipping';
  return `<section class="trust">
    <div>${ICONS.truck}<div><strong>Fast shipping</strong><span>${esc(ship)}</span></div></div>
    <div>${ICONS.shield}<div><strong>Secure checkout</strong><span>Cards, Apple Pay, Google Pay</span></div></div>
    <div>${ICONS.check}<div><strong>Tested &amp; described honestly</strong><span>Condition stated on every item</span></div></div>
    <div>${ICONS.box}<div><strong>Order tracking</strong><span>Tracking number on every shipment</span></div></div>
  </section>`;
}

export function orderSummaryTable(order) {
  const c = order.currency;
  return `<table class="order-items">
    <thead><tr><th>Item</th><th>Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>${order.items.map((it) => `<tr><td><div class="item-cell"><img src="${attr(imgUrl(it.image))}" alt=""><span>${esc(it.name)}</span></div></td><td>${it.qty}</td><td class="num">${money(it.unit_cents, c)}</td><td class="num">${money(it.unit_cents * it.qty, c)}</td></tr>`).join('')}</tbody>
    <tfoot>
      <tr><td colspan="3" class="num">Subtotal</td><td class="num">${money(order.subtotal_cents, c)}</td></tr>
      <tr><td colspan="3" class="num">Shipping</td><td class="num">${order.shipping_cents ? money(order.shipping_cents, c) : 'Free'}</td></tr>
      ${order.tax_cents ? `<tr><td colspan="3" class="num">Tax</td><td class="num">${money(order.tax_cents, c)}</td></tr>` : ''}
      <tr class="total"><td colspan="3" class="num">Total</td><td class="num">${money(order.total_cents, c)}</td></tr>
    </tfoot></table>`;
}

export function addressBlock(a = {}) {
  const lines = [a.name, a.line1, a.line2, [a.city, a.state, a.postal].filter(Boolean).join(', '), a.country, a.phone].filter(Boolean);
  return `<address>${lines.map(esc).join('<br>')}</address>`;
}
