// Pure cart/pricing math. All amounts are integer minor units (cents).

const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'pyg', 'xaf', 'xof', 'bif', 'djf', 'gnf', 'kmf', 'mga', 'rwf', 'ugx', 'xpf']);

export function formatMoney(cents, currency = 'usd', locale = 'en-US') {
  const cur = String(currency || 'usd').toUpperCase();
  const zero = ZERO_DECIMAL.has(cur.toLowerCase());
  const amount = zero ? cents : cents / 100;
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).format(amount); }
  catch { return `${cur} ${zero ? amount : amount.toFixed(2)}`; }
}

/** Parse a user-entered price like "12.50" or "1,299" into cents. Returns null if invalid. */
export function parsePrice(text, currency = 'usd') {
  if (text === undefined || text === null) return null;
  const s = String(text).replace(/[^0-9.\-]/g, '');
  if (!s || s === '.' || s === '-') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return ZERO_DECIMAL.has(String(currency).toLowerCase()) ? Math.round(n) : Math.round(n * 100);
}

/**
 * Compute totals for cart lines [{price_cents, qty}] with settings {tax_rate (percent string), shipping_flat_cents, free_shipping_over_cents}.
 */
export function computeTotals(lines, settings = {}) {
  const subtotal = lines.reduce((s, l) => s + Number(l.price_cents) * Number(l.qty), 0);
  const flat = Number(settings.shipping_flat_cents || 0);
  const freeOver = settings.free_shipping_over_cents === '' || settings.free_shipping_over_cents === undefined ? null : Number(settings.free_shipping_over_cents);
  let shipping = subtotal > 0 ? flat : 0;
  if (freeOver !== null && Number.isFinite(freeOver) && freeOver >= 0 && subtotal >= freeOver) shipping = 0;
  const rate = Number(settings.tax_rate || 0);
  const tax = Math.round(subtotal * (Number.isFinite(rate) ? rate : 0) / 100);
  return { subtotal, shipping, tax, total: subtotal + shipping + tax, count: lines.reduce((s, l) => s + Number(l.qty), 0) };
}

/** Validate cart lines against stock/status. Returns array of problems (empty when OK). */
export function cartProblems(lines) {
  const problems = [];
  for (const l of lines) {
    if (l.status !== 'active') problems.push({ product_id: l.product_id, message: `"${l.name}" is no longer available.` });
    else if (l.qty > l.stock) problems.push({ product_id: l.product_id, message: l.stock > 0 ? `Only ${l.stock} of "${l.name}" left in stock.` : `"${l.name}" is sold out.` });
  }
  return problems;
}

export function clampQty(v, max = 99) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(max, n));
}
