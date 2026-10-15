import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeForm, StripeClient, constructWebhookEvent, signWebhookPayload } from '../src/stripe.mjs';

test('encodeForm flattens nested objects the Stripe way', () => {
  const p = encodeForm({ mode: 'payment', line_items: [{ quantity: 2, price_data: { currency: 'usd', product_data: { name: 'A B' } } }], metadata: { order_id: 7 } });
  assert.equal(p.toString(), 'mode=payment&line_items%5B0%5D%5Bquantity%5D=2&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd&line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=A+B&metadata%5Border_id%5D=7');
});

test('createCheckoutSession posts the right payload', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) }; };
  const client = new StripeClient('sk_test_x', { fetchImpl });
  const order = { id: 12, number: 'RS-1', email: 'c@x.io', currency: 'usd', shipping_cents: 799, tax_cents: 0, items: [{ name: 'GPU', unit_cents: 48900, qty: 1, image: 'a.png' }] };
  const sess = await client.createCheckoutSession({ order, baseUrl: 'https://shop.example.com', successUrl: '/checkout/success?order=RS-1&session_id={CHECKOUT_SESSION_ID}', cancelUrl: '/checkout/cancel?order=RS-1' });
  assert.equal(sess.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'order-RS-1-session');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('mode'), 'payment');
  assert.equal(body.get('line_items[0][price_data][unit_amount]'), '48900');
  assert.equal(body.get('line_items[0][price_data][product_data][images][0]'), 'https://shop.example.com/uploads/a.png');
  assert.equal(body.get('line_items[1][price_data][product_data][name]'), 'Shipping');
  assert.equal(body.get('line_items[1][price_data][unit_amount]'), '799');
  assert.equal(body.get('metadata[order_id]'), '12');
  assert.equal(body.get('success_url'), 'https://shop.example.com/checkout/success?order=RS-1&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(body.get('customer_email'), 'c@x.io');
});

test('Stripe API errors surface the message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'Your card was declined.' } }) });
  const client = new StripeClient('sk', { fetchImpl });
  await assert.rejects(client.retrieveCheckoutSession('cs_1'), /declined/);
});

test('webhook signature verification', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { metadata: { order_id: '3' } } } });
  const secret = 'whsec_abc';
  const header = signWebhookPayload(payload, secret);
  const ev = constructWebhookEvent(payload, header, secret);
  assert.equal(ev.type, 'checkout.session.completed');
  assert.equal(constructWebhookEvent(Buffer.from(payload), header, secret).id, 'evt_1');
  assert.throws(() => constructWebhookEvent(payload, header, 'wrong'), /mismatch/);
  assert.throws(() => constructWebhookEvent(payload + ' ', header, secret), /mismatch/);
  assert.throws(() => constructWebhookEvent(payload, 'garbage', secret), /Malformed/);
  const old = signWebhookPayload(payload, secret, Math.floor(Date.now() / 1000) - 1000);
  assert.throws(() => constructWebhookEvent(payload, old, secret), /tolerance/);
  assert.throws(() => constructWebhookEvent(payload, header, ''), /Missing/);
});
