// HTML rendering helpers: escaping, layout, small components.
import { formatMoney } from './cart.mjs';
import { CONDITIONS } from './db.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');
export const money = (cents, currency) => formatMoney(cents, currency);
export const condLabel = (c) => CONDITIONS[c] || c;
export const imgUrl = (filename) => (filename ? `/uploads/${encodeURIComponent(filename)}` : '/public/placeholder.svg');
export const fmtDate = (iso) => (iso ? new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function layout({ title, body, ctx, admin = false, head = '' }) {
  const { settings, user, cartCount = 0, flash, csrf } = ctx;
  const shop = esc(settings.shop_name || 'Shop');
  const nav = admin
    ? `<a href="/admin">Dashboard</a><a href="/admin/products">Products</a><a href="/admin/orders">Orders</a><a href="/admin/categories">Categories</a><a href="/admin/settings">Settings</a><a href="/" class="muted">View shop</a>`
    : `<a href="/shop">Shop</a>${ctx.categories?.slice(0, 5).map((c) => `<a href="/shop?cat=${attr(c.slug)}">${esc(c.name)}</a>`).join('') || ''}`;
  const account = user
    ? `<a href="${user.role === 'admin' ? '/admin' : '/account'}" class="nav-user">${esc(user.name || user.email)}</a><form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${attr(csrf)}"><button class="link">Log out</button></form>`
    : `<a href="/login">Log in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · ${settings.shop_name}` : settings.shop_name)}</title>
<link rel="stylesheet" href="/public/style.css">
<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">
${head}
</head>
<body class="${admin ? 'admin' : 'store'}">
<header class="site-header">
  <div class="wrap">
    <a href="/" class="brand">${shop}${admin ? ' <span class="badge">admin</span>' : ''}</a>
    <nav class="main-nav">${nav}</nav>
    <div class="header-right">
      ${admin ? '' : `<form action="/shop" method="get" class="search"><input type="search" name="q" placeholder="Search products" value="${attr(ctx.q || '')}" aria-label="Search"></form>`}
      ${account}
      ${admin ? '' : `<a href="/cart" class="cart-link" aria-label="Cart">🛒 <span class="cart-count">${cartCount}</span></a>`}
    </div>
  </div>
</header>
${flash ? `<div class="flash ${flash.type}"><div class="wrap">${esc(flash.message)}</div></div>` : ''}
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">&copy; ${new Date().getFullYear()} ${shop}${settings.contact_email ? ` · <a href="mailto:${attr(settings.contact_email)}">${esc(settings.contact_email)}</a>` : ''} · <a href="/orders/lookup">Track an order</a></div></footer>
<script src="/public/app.js" defer></script>
</body>
</html>`;
}

export function productCard(p, currency) {
  const soldOut = p.stock <= 0;
  return `<a class="card product-card${soldOut ? ' sold-out' : ''}" href="/p/${attr(p.slug)}">
    <div class="thumb"><img src="${attr(imgUrl(p.image))}" alt="${attr(p.name)}" loading="lazy">${soldOut ? '<span class="ribbon">Sold out</span>' : p.compare_price_cents > p.price_cents ? '<span class="ribbon sale">Sale</span>' : ''}</div>
    <div class="card-body">
      <div class="card-title">${esc(p.name)}</div>
      <div class="card-meta">${esc(condLabel(p.condition))}${p.category_name ? ` · ${esc(p.category_name)}` : ''}</div>
      <div class="price">${money(p.price_cents, currency)}${p.compare_price_cents > p.price_cents ? ` <s class="compare">${money(p.compare_price_cents, currency)}</s>` : ''}</div>
    </div></a>`;
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
