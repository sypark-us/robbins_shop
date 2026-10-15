// End-to-end smoke test over HTTP: starts the app on a temp data dir and walks through admin setup,
// product upload (multipart), storefront browsing, cart, checkout, test-mode payment, order tracking,
// admin fulfilment, and the Stripe path with a mocked Stripe API + signed webhook.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { signWebhookPayload } from '../src/stripe.mjs';
import { makePng } from '../src/png.mjs';

let failures = 0, passes = 0;
const check = (cond, msg) => { if (cond) { passes++; console.log(`PASS ${msg}`); } else { failures++; console.log(`FAIL ${msg}`); } };

const dataDir = mkdtempSync(join(tmpdir(), 'rs-smoke-'));
const stripeCalls = [];
const fakeStripe = async (url, init) => {
  stripeCalls.push({ url, body: new URLSearchParams(init?.body || '') });
  if (url.endsWith('/checkout/sessions')) return { ok: true, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }) };
  if (url.includes('/checkout/sessions/cs_test_123')) return { ok: true, json: async () => ({ id: 'cs_test_123', payment_status: 'paid', payment_intent: 'pi_123', metadata: { order_id: String(stripeOrderId) } }) };
  if (url.endsWith('/refunds')) return { ok: true, json: async () => ({ id: 're_1' }) };
  if (url.startsWith('https://api.frankfurter.app/')) { fxCalls++; return { ok: true, json: async () => ({ base: 'USD', rates: { KRW: 1400 } }) }; }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not mocked' } }) };
};
let stripeOrderId = 0, fxCalls = 0;
const app = createApp({ dataDir, env: { ADMIN_EMAIL: '', ADMIN_PASSWORD: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', BASE_URL: '' }, fetchImpl: fakeStripe, log: () => {} });
const server = createServer(app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** Cookie-jar client. */
function client() {
  let cookie = '';
  const req = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = raw;
    if (body && !raw) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  };
  const csrf = async (path) => { const r = await req(path); const m = /name="_csrf" value="([^"]+)"/.exec(r.text); return { token: m ? m[1] : null, page: r }; };
  return { req, csrf };
}

try {
  // --- first run: admin setup ---
  const admin = client();
  let r = await admin.req('/admin');
  check(r.status === 303 && r.location === '/admin/setup', 'admin redirects to setup on first run');
  let { token } = await admin.csrf('/admin/setup');
  r = await admin.req('/admin/setup', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', email: 'owner@example.com', password: 'password123' } });
  check(r.status === 303 && r.location === '/admin', 'admin account created');
  r = await admin.req('/admin');
  check(r.status === 200 && r.text.includes('Dashboard') && r.text.includes('test mode'), 'dashboard loads in test mode');

  // --- settings ---
  ({ token } = await admin.csrf('/admin/settings'));
  r = await admin.req('/admin/settings', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', tagline: 'tag', tagline_ko: '태그', contact_email: '', currency: 'usd', tax_rate: '10', shipping_flat: '5.00', free_shipping_over: '100', base_url: '', stripe_secret_key: '', stripe_webhook_secret: '' } });
  check(r.status === 303, 'settings saved');

  // --- category + product with image upload (multipart) ---
  ({ token } = await admin.csrf('/admin/categories'));
  await admin.req('/admin/categories', { method: 'POST', body: { _csrf: token, name: 'Computer parts' } });
  r = await admin.req('/admin/categories');
  check(r.text.includes('computer-parts'), 'category created');
  const catId = /value="(\d+)"[^>]*>Computer parts/.exec((await admin.req('/admin/products/new')).text)?.[1];
  check(!!catId, 'category appears in product form');

  const boundary = 'SmokeBoundary42';
  const field = (n, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const png = makePng(80, 60, [10, 20, 30], [200, 210, 220]);
  const parts = [field('_csrf', token), field('name', 'RTX 4070 <Used>'), field('description', 'Line one\nLine two'), field('price', '489.00'), field('compare_price', '549'),
    field('stock', '2'), field('sku', 'GPU-1'), field('condition', 'like_new'), field('category_id', catId), field('status', 'active'), field('featured', '1')];
  const multipart = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="gpu.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="evil.svg"\r\nContent-Type: image/svg+xml\r\n\r\n<svg onload="alert(1)"/>\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  r = await admin.req('/admin/products', { method: 'POST', raw: multipart, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  check(r.status === 303 && /\/admin\/products\/\d+\/edit/.test(r.location), 'product created via multipart upload');
  const productId = Number(/\/admin\/products\/(\d+)\/edit/.exec(r.location)[1]);
  r = await admin.req(r.location);
  check(r.text.includes('1 image(s) were rejected'), 'SVG upload rejected, PNG accepted');
  const imgMatch = /\/uploads\/([\w.-]+\.png)/.exec(r.text);
  check(!!imgMatch && existsSync(join(app.uploadsDir, imgMatch[1])), 'uploaded image saved to disk');
  const imgRes = await fetch(`${base}/uploads/${imgMatch[1]}`);
  check(imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png', 'uploaded image served with PNG content type');
  check((await fetch(`${base}/uploads/..%2Fshop.db`)).status === 404, 'path traversal blocked');

  // second product via urlencoded
  ({ token } = await admin.csrf('/admin/products/new'));
  r = await admin.req('/admin/products', { method: 'POST', body: { _csrf: token, name: 'Plain Tee', price: '15', stock: '10', condition: 'new', status: 'active' } });
  check(r.status === 303, 'second product created');
  r = await admin.req('/admin/products', { method: 'POST', body: { _csrf: 'bad', name: 'X', price: '1' } });
  check(r.status === 403, 'CSRF token enforced');
  r = await admin.req('/admin/products', { method: 'POST', body: { _csrf: token, name: '', price: 'abc' } });
  check(r.status === 200 && r.text.includes('Name is required') && r.text.includes('valid price'), 'validation errors shown');

  // --- storefront ---
  const shopper = client();
  r = await shopper.req('/');
  check(r.status === 200 && r.text.includes('RTX 4070 &lt;Used&gt;') && r.text.includes('Smoke Shop'), 'home page lists product with escaped name');
  check(r.text.includes('class="ribbon sale"'), 'sale ribbon when compare price higher');
  r = await shopper.req('/shop?q=rtx');
  check(r.text.includes('Results for') && r.text.includes('1 item'), 'search works');
  r = await shopper.req('/shop?cat=computer-parts&cond=like_new');
  check(r.text.includes('1 item'), 'category + condition filter');
  r = await shopper.req('/shop?cond=used');
  check(r.text.includes('Nothing matched'), 'empty result message');
  const api = (await shopper.req('/api/products')).json();
  const gpu = api.items.find((p) => p.name.startsWith('RTX'));
  check(api.total === 2 && gpu.image?.startsWith('/uploads/') && gpu.currency === 'usd', 'JSON API lists products');
  r = await shopper.req(gpu.url);
  check(r.status === 200 && r.text.includes('Only 2 left') && r.text.includes('Line one<br>Line two') && r.text.includes('$489.00') && r.text.includes('GPU-1'), 'product page shows details');
  check(r.text.includes('Add to cart'), 'add to cart form present');
  check((await shopper.req('/p/does-not-exist')).status === 404, '404 for unknown product');
  check((await shopper.req('/admin')).status === 303, 'guest cannot open admin');
  check((await shopper.req('/admin/products/new')).status === 303, 'guest redirected from admin product form');

  // --- cart ---
  let { token: st } = await shopper.csrf(gpu.url);
  r = await shopper.req('/cart/add', { method: 'POST', body: { _csrf: st, product_id: gpu.id, qty: '1' } });
  check(r.status === 303 && r.location === '/cart', 'added to cart');
  r = await shopper.req('/cart/add', { method: 'POST', body: { _csrf: st, product_id: gpu.id, qty: '5' } });
  check(r.location === gpu.url, 'over-stock add rejected');
  r = await shopper.req('/cart');
  check(r.text.includes('Only 2 of') && r.text.includes('$489.00') && r.text.includes('<span class="cart-count">1</span>'), 'cart shows flash + line + count');
  check(r.text.includes('Free') , 'free shipping over threshold');
  check(r.text.includes('$48.90'), 'tax computed at 10%');
  r = await shopper.req('/cart/update', { method: 'POST', body: { _csrf: st, product_id: gpu.id, qty: '2' } });
  r = await shopper.req('/cart');
  check(r.text.includes('$978.00'), 'quantity updated');
  const tee = api.items.find((p) => p.name === 'Plain Tee');
  await shopper.req('/cart/add', { method: 'POST', body: { _csrf: st, product_id: tee.id, qty: '1' } });
  await shopper.req('/cart/update', { method: 'POST', body: { _csrf: st, product_id: tee.id, remove: '' } });
  r = await shopper.req('/cart');
  check(!r.text.includes('Plain Tee'), 'item removed');

  // --- checkout (test mode) ---
  r = await shopper.req('/checkout');
  check(r.status === 200 && r.text.includes('test mode'), 'checkout page in test mode');
  r = await shopper.req('/checkout', { method: 'POST', body: { _csrf: st, email: 'bad', name: '', line1: '1 Main', city: 'Town', postal: '00000', country: 'US' } });
  check(r.status === 200 && r.text.includes('valid email') && r.text.includes('enter your name'), 'checkout validation');
  const addr = { _csrf: st, email: 'Buyer@Example.com', name: 'Buyer One', line1: '1 Main St', line2: '', city: 'Town', state: 'CA', postal: '90001', country: 'US', phone: '', notes: 'Leave at door' };
  r = await shopper.req('/checkout', { method: 'POST', body: addr });
  check(r.status === 303 && /^\/pay\/test\/RS-/.test(r.location), 'order created, redirected to test payment');
  const orderNumber = r.location.split('/').pop();
  check((await shopper.req(`/api/products`)).json().items.find((p) => p.id === gpu.id).stock === 0, 'stock reserved on order creation');
  r = await shopper.req(r.location);
  check(r.status === 200 && r.text.includes('$1,075.80'), 'test payment page shows total (978 + 97.80 tax)');
  r = await shopper.req(`/pay/test/${orderNumber}`, { method: 'POST', body: { _csrf: st, outcome: 'paid' } });
  check(r.status === 303 && r.location === `/order/${orderNumber}?thanks=1`, 'test payment completed');
  r = await shopper.req(r.location);
  check(r.text.includes('Thank you for your order') && r.text.includes('status-paid') && r.text.includes('Buyer One') && r.text.includes('90001'), 'order confirmation page');
  check(r.text.includes('<span class="cart-count">0</span>'), 'cart emptied after payment');

  // --- order lookup by another visitor ---
  const other = client();
  check((await other.req(`/order/${orderNumber}`)).status === 404, 'strangers cannot view the order');
  let { token: ot } = await other.csrf('/orders/lookup');
  r = await other.req('/orders/lookup', { method: 'POST', body: { _csrf: ot, number: orderNumber.toLowerCase(), email: 'buyer@example.com' } });
  check(r.location === `/order/${orderNumber}`, 'order lookup by number + email');
  check((await other.req(r.location)).status === 200, 'order visible after lookup');
  r = await other.req('/orders/lookup', { method: 'POST', body: { _csrf: ot, number: orderNumber, email: 'wrong@example.com' } });
  check(r.location === '/orders/lookup', 'lookup with wrong email fails');

  // --- customer account ---
  const cust = client();
  let { token: ct } = await cust.csrf('/register');
  r = await cust.req('/register', { method: 'POST', body: { _csrf: ct, name: 'Cust', email: 'cust@example.com', password: 'password123' } });
  check(r.status === 303 && r.location === '/account', 'customer registered');
  r = await cust.req('/account');
  check(r.status === 200 && r.text.includes('cust@example.com') && r.text.includes('No orders yet'), 'account page');
  check((await cust.req('/admin')).status === 403, 'customer cannot open admin');
  ({ token: ct } = await cust.csrf('/account'));
  r = await cust.req('/logout', { method: 'POST', body: { _csrf: ct } });
  check(r.status === 303 && (await cust.req('/account')).status === 303, 'logout works');
  ({ token: ct } = await cust.csrf('/login'));
  r = await cust.req('/login', { method: 'POST', body: { _csrf: ct, email: 'cust@example.com', password: 'nope' } });
  check(r.status === 200 && r.text.includes('Wrong email or password'), 'bad login rejected');
  r = await cust.req('/login?next=/account', { method: 'POST', body: { _csrf: ct, email: 'cust@example.com', password: 'password123' } });
  check(r.status === 303 && r.location === '/account', 'login works');

  // --- admin fulfilment ---
  r = await admin.req('/admin/orders?status=paid');
  check(r.text.includes(orderNumber) && r.text.includes('Buyer One'), 'admin sees paid order');
  const orderId = Number(/\/admin\/orders\/(\d+)/.exec(r.text)[1]);
  r = await admin.req(`/admin/orders/${orderId}`);
  check(r.text.includes('Leave at door') && r.text.includes('1 Main St'), 'admin order detail shows notes and address');
  ({ token } = await admin.csrf(`/admin/orders/${orderId}`));
  await admin.req(`/admin/orders/${orderId}/status`, { method: 'POST', body: { _csrf: token, status: 'shipped', tracking: '1Z999AA' } });
  r = await shopper.req(`/order/${orderNumber}`);
  check(r.text.includes('status-shipped') && r.text.includes('1Z999AA'), 'customer sees shipped status and tracking');
  r = await admin.req('/admin');
  check(r.text.includes('$1,075.80') && r.text.includes('Low stock'), 'dashboard revenue updated');

  // --- Stripe path with mocked API ---
  ({ token } = await admin.csrf('/admin/settings'));
  await admin.req('/admin/settings', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', tagline: '', contact_email: '', currency: 'usd', tax_rate: '0', shipping_flat: '0', free_shipping_over: '', base_url: 'https://shop.example.com', stripe_secret_key: 'sk_test_fake', stripe_webhook_secret: 'whsec_fake' } });
  const s2 = client();
  let { token: s2t } = await s2.csrf(tee.url);
  await s2.req('/cart/add', { method: 'POST', body: { _csrf: s2t, product_id: tee.id, qty: '3' } });
  r = await s2.req('/checkout');
  check(r.text.includes('secure Stripe checkout'), 'checkout page in live mode');
  r = await s2.req('/checkout', { method: 'POST', body: { ...addr, _csrf: s2t, email: 'stripe@example.com' } });
  check(r.status === 303 && r.location === 'https://checkout.stripe.com/c/pay/cs_test_123', 'redirected to Stripe Checkout');
  const sc = stripeCalls.find((c) => c.url.endsWith('/checkout/sessions'));
  check(sc.body.get('line_items[0][price_data][unit_amount]') === '1500' && sc.body.get('line_items[0][quantity]') === '3' && sc.body.get('success_url').startsWith('https://shop.example.com/checkout/success?order=RS-'), 'Stripe session payload correct');
  const stripeOrderNumber = /order=(RS-[^&]+)/.exec(sc.body.get('success_url'))[1];
  stripeOrderId = Number(sc.body.get('metadata[order_id]'));
  check((await s2.req(`/pay/test/${stripeOrderNumber}`)).status === 404, 'test payment page disabled in live mode');

  // webhook: bad signature, then good
  const evt = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_123', payment_status: 'paid', payment_intent: 'pi_123', metadata: { order_id: String(stripeOrderId) } } } });
  r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: evt, headers: { 'Stripe-Signature': signWebhookPayload(evt, 'whsec_wrong') } });
  check(r.status === 400, 'webhook with bad signature rejected');
  r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: evt, headers: { 'Stripe-Signature': signWebhookPayload(evt, 'whsec_fake') } });
  check(r.status === 200, 'signed webhook accepted');
  r = await s2.req(`/checkout/success?order=${stripeOrderNumber}&session_id=cs_test_123`);
  check(r.status === 303 && r.location === `/order/${stripeOrderNumber}?thanks=1`, 'success URL redirects to order');
  r = await s2.req(r.location);
  check(r.text.includes('status-paid') && r.text.includes('<span class="cart-count">0</span>'), 'Stripe order paid and cart cleared');
  r = await admin.req(`/admin/orders/${stripeOrderId}`);
  check(r.text.includes('pi_123') && r.text.includes('Refund via Stripe'), 'admin sees payment intent and refund button');
  ({ token } = await admin.csrf(`/admin/orders/${stripeOrderId}`));
  await admin.req(`/admin/orders/${stripeOrderId}/refund`, { method: 'POST', body: { _csrf: token } });
  r = await admin.req(`/admin/orders/${stripeOrderId}`);
  check(r.text.includes('status-refunded') && r.text.includes('Refund issued'), 'refund via Stripe marks order refunded');
  check((await s2.req('/api/products')).json().items.find((p) => p.id === tee.id).stock === 10, 'refund restocks items');

  // cancel path: new order then cancel URL
  await s2.req('/cart/add', { method: 'POST', body: { _csrf: s2t, product_id: tee.id, qty: '1' } });
  r = await s2.req('/checkout', { method: 'POST', body: { ...addr, _csrf: s2t, email: 'stripe@example.com' } });
  const cancelNumber = /order=(RS-[^&]+)/.exec(stripeCalls.at(-1).body.get('cancel_url'))[1];
  r = await s2.req(`/checkout/cancel?order=${cancelNumber}`);
  check(r.status === 303 && r.location === '/cart', 'cancel redirects to cart');
  check(app.db.prepare('SELECT status FROM orders WHERE number = ?').get(cancelNumber).status === 'cancelled', 'cancelled order restocked');
  check((await s2.req('/api/products')).json().items.find((p) => p.id === tee.id).stock === 10, 'stock restored after cancel');

  // --- Korean language ---
  ({ token } = await admin.csrf('/admin/categories'));
  await admin.req('/admin/categories', { method: 'POST', body: { _csrf: token, name: 'Clothing', name_ko: '의류' } });
  r = await admin.req('/admin/categories');
  check(r.text.includes('value="의류"'), 'category created with Korean name');
  const catIdKo = /action="\/admin\/categories\/(\d+)"><td>.*?value="Computer parts"/s.exec(r.text)?.[1];
  await admin.req(`/admin/categories/${catIdKo}`, { method: 'POST', body: { _csrf: token, name: 'Computer parts', name_ko: '컴퓨터 부품' } });
  ({ token } = await admin.csrf(`/admin/products/${productId}/edit`));
  r = await admin.req(`/admin/products/${productId}`, { method: 'POST', body: { _csrf: token, name: 'RTX 4070 <Used>', name_ko: 'RTX 4070 그래픽카드', description: 'Line one\nLine two', description_ko: '한국어 설명', price: '489.00', compare_price: '549', stock: '2', sku: 'GPU-1', condition: 'like_new', category_id: catId, status: 'active', featured: '1', slug: gpu.slug.replace(/^\//, '') } });
  check(r.status === 303, 'product updated with Korean fields');
  const ko = client();
  r = await ko.req('/?lang=ko');
  check(r.status === 200 && r.text.includes('<html lang="ko">') && r.text.includes('전체 상품') && r.text.includes('컴퓨터 부품'), 'home renders in Korean with translated category');
  r = await ko.req('/shop');
  check(r.text.includes('RTX 4070 그래픽카드') && r.text.includes('거의 새것') && !r.text.includes('All products'), 'language remembered; Korean product name and condition shown');
  r = await ko.req('/shop?q=그래픽카드');
  check(r.text.includes('1개 상품'), 'search matches Korean name');
  r = await ko.req(gpu.url);
  check(r.text.includes('한국어 설명') && r.text.includes('장바구니 담기') && r.text.includes('재고 2개 남음'), 'Korean product page');
  r = await ko.req('/p/missing-item');
  check(r.status === 404 && r.text.includes('상품을 찾을 수 없습니다'), 'Korean 404 message');
  r = await ko.req('/shop?lang=en');
  check(r.text.includes('All products') && r.text.includes('RTX 4070 &lt;Used&gt;'), 'switch back to English');
  r = await admin.req('/admin?lang=ko');
  check(r.text.includes('대시보드') && r.text.includes('매출'), 'admin renders in Korean');
  r = await admin.req('/admin/products/new?lang=ko');
  check(r.text.includes('상품명 (한국어)') && r.text.includes('name="name_ko"'), 'admin product form has Korean fields');
  await admin.req('/admin?lang=en');

  // --- display currency (KRW) ---
  check(fxCalls === 1, 'exchange rate fetched automatically on first run (auto-update is on by default)');
  ({ token } = await admin.csrf('/admin/settings'));
  await admin.req('/admin/settings', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', tagline: '', contact_email: '', currency: 'usd', tax_rate: '0', shipping_flat: '0', free_shipping_over: '100', base_url: 'https://shop.example.com', stripe_secret_key: '', stripe_webhook_secret: '', alt_currency: 'krw', fx_rate: '1350' } });
  r = await admin.req('/admin/settings');
  check(r.text.includes('value="1350"') && r.text.includes('Rate last updated'), 'manual exchange rate saved');
  const krw = client();
  r = await krw.req(gpu.url);
  check(r.text.includes('$489.00') && r.text.includes('class="lang-switch cur-switch"') && r.text.includes('?cur=krw'), 'English visitor sees USD and a USD|KRW switch');
  r = await krw.req(`${gpu.url}?cur=krw`);
  check(r.text.includes('₩660,150') && r.text.includes('₩741,150') && !r.text.includes('$489.00'), 'KRW display converts price and compare price');
  r = await krw.req('/');
  check(r.text.includes('₩660,150') && r.text.includes('₩135,000'), 'currency choice remembered; free-shipping threshold converted');
  await krw.req('/cart/add', { method: 'POST', body: { _csrf: /name="_csrf" value="([^"]+)"/.exec(r.text)[1], product_id: gpu.id, qty: '1' } });
  r = await krw.req('/checkout');
  check(r.text.includes('₩660,150') && r.text.includes('Prices shown in KRW are approximate') && r.text.includes('charged in USD'), 'checkout shows KRW with approximate note');
  const koKrw = client();
  r = await koKrw.req('/?lang=ko');
  check(r.text.includes('₩660,150'), 'Korean-language visitors default to KRW');
  r = await koKrw.req('/?cur=usd');
  check(r.text.includes('US$489.00'), 'Korean visitor can switch back to USD');
  r = await admin.req('/admin/products');
  check(r.text.includes('$489.00') && !r.text.includes('₩'), 'admin stays in base currency');
  // auto-refresh fetches from frankfurter when enabled
  ({ token } = await admin.csrf('/admin/settings'));
  await admin.req('/admin/settings', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', tagline: '', contact_email: '', currency: 'usd', tax_rate: '0', shipping_flat: '0', free_shipping_over: '100', base_url: 'https://shop.example.com', stripe_secret_key: '', stripe_webhook_secret: '', alt_currency: 'krw', fx_rate: '1350', fx_auto: '1' } });
  await new Promise((res) => setTimeout(res, 50));
  check(fxCalls === 2 && app.db.prepare("SELECT value FROM settings WHERE key='fx_rate'").get().value === '1400', 'auto-update fetched the ECB rate');
  r = await krw.req(gpu.url);
  check(r.text.includes('₩684,600'), 'new rate applied to displayed prices');
  await admin.req('/admin/settings', { method: 'POST', body: { _csrf: token, shop_name: 'Smoke Shop', tagline: '', contact_email: '', currency: 'usd', tax_rate: '0', shipping_flat: '0', free_shipping_over: '', base_url: 'https://shop.example.com', stripe_secret_key: '', stripe_webhook_secret: '', alt_currency: '', fx_rate: '' } });
  r = await krw.req(gpu.url);
  check(r.text.includes('$489.00') && !r.text.includes('cur-switch'), 'disabling the second currency removes the switch');

  // --- static & misc ---
  check((await fetch(`${base}/public/style.css`)).headers.get('content-type').startsWith('text/css'), 'static css served');
  check((await fetch(`${base}/nope`)).status === 404, 'unknown route 404');
  check((await fetch(`${base}/api/health`)).ok, 'health endpoint');
} catch (e) {
  failures++;
  console.log('EXCEPTION', e.stack || e);
} finally {
  server.close();
  app.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\nSMOKE-RESULTS passed ${passes} failed ${failures}`);
console.log(failures ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
process.exit(failures ? 1 : 0);
