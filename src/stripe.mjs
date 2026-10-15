// Stripe Checkout integration over the REST API (no SDK). https://docs.stripe.com/api/checkout/sessions
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

/** Flatten a nested object into Stripe's bracket form-encoding: {a:{b:[{c:1}]}} -> a[b][0][c]=1 */
export function encodeForm(obj, prefix = '', params = new URLSearchParams()) {
  if (obj === null || obj === undefined) return params;
  if (Array.isArray(obj)) obj.forEach((v, i) => encodeForm(v, `${prefix}[${i}]`, params));
  else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) encodeForm(v, prefix ? `${prefix}[${k}]` : k, params);
  } else params.append(prefix, String(obj));
  return params;
}

export class StripeClient {
  constructor(secretKey, { fetchImpl = globalThis.fetch } = {}) {
    if (!secretKey) throw new Error('Stripe secret key required');
    this.key = secretKey; this.fetch = fetchImpl;
  }
  async request(method, path, body, idempotencyKey) {
    const headers = { Authorization: `Bearer ${this.key}`, 'Stripe-Version': '2024-06-20' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = encodeForm(body).toString(); }
    const res = await this.fetch(`${API}${path}`, { method, headers, body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Stripe error ${res.status}`);
      err.status = res.status; err.stripe = data?.error; throw err;
    }
    return data;
  }
  /** Create a hosted Checkout Session for an order. Returns { id, url }. */
  createCheckoutSession({ order, successUrl, cancelUrl, baseUrl }) {
    const abs = (u) => (u.startsWith('http') ? u : `${baseUrl}${u}`);
    const line_items = order.items.map((it) => ({
      quantity: it.qty,
      price_data: {
        currency: order.currency,
        unit_amount: it.unit_cents,
        product_data: { name: it.name, ...(it.image && baseUrl && /^https:/.test(baseUrl) ? { images: [`${baseUrl}/uploads/${it.image}`] } : {}) },
      },
    }));
    if (order.shipping_cents > 0) line_items.push({ quantity: 1, price_data: { currency: order.currency, unit_amount: order.shipping_cents, product_data: { name: 'Shipping' } } });
    if (order.tax_cents > 0) line_items.push({ quantity: 1, price_data: { currency: order.currency, unit_amount: order.tax_cents, product_data: { name: 'Sales tax' } } });
    return this.request('POST', '/checkout/sessions', {
      mode: 'payment',
      line_items,
      customer_email: order.email,
      client_reference_id: order.number,
      metadata: { order_id: order.id, order_number: order.number },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.number }, description: `Order ${order.number}` },
      success_url: abs(successUrl),
      cancel_url: abs(cancelUrl),
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour (Stripe minimum 30 min)
    }, `order-${order.number}-session`);
  }
  retrieveCheckoutSession(id) { return this.request('GET', `/checkout/sessions/${encodeURIComponent(id)}`); }
  refundPaymentIntent(paymentIntentId) { return this.request('POST', '/refunds', { payment_intent: paymentIntentId }); }
}

/** Verify a Stripe webhook signature header and return the parsed event. Throws on failure. */
export function constructWebhookEvent(payload, sigHeader, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!sigHeader || !secret) throw new Error('Missing signature or secret');
  const parts = Object.create(null);
  for (const kv of String(sigHeader).split(',')) {
    const [k, v] = kv.split('=').map((s) => s.trim());
    if (k === 't') parts.t = v; else if (k === 'v1') (parts.v1 ||= []).push(v);
  }
  if (!parts.t || !parts.v1) throw new Error('Malformed signature header');
  const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  const expected = createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');
  const ok = parts.v1.some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new Error('Signature mismatch');
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceSec) throw new Error('Timestamp outside tolerance');
  return JSON.parse(body);
}

/** Build a signature header (used by tests and the local webhook simulator). */
export function signWebhookPayload(payload, secret, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
