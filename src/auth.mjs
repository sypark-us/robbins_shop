// Password hashing (scrypt), cookie signing (HMAC) and random ids.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(String(password), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const randomId = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function sign(value, secret) {
  const sig = createHmac('sha256', secret).update(String(value)).digest('base64url');
  return `${value}.${sig}`;
}
export function unsign(signed, secret) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = sign(value, secret);
  const a = Buffer.from(signed), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

/** Simple in-memory rate limiter keyed by string (e.g. ip:login). */
export class RateLimiter {
  constructor(max = 10, windowMs = 15 * 60 * 1000) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) { entry = { start: now, count: 0 }; this.hits.set(key, entry); }
    entry.count++;
    if (this.hits.size > 10000) for (const [k, e] of this.hits) if (now - e.start > this.windowMs) this.hits.delete(k);
    return entry.count <= this.max;
  }
  reset(key) { this.hits.delete(key); }
}

export const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;
