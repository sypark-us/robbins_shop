// SQLite data layer (node:sqlite, no native deps). Schema is created/migrated on open.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CONDITIONS = {
  new: 'New',
  like_new: 'Like new',
  used: 'Used',
  refurbished: 'Refurbished',
  for_parts: 'For parts / not working',
};
export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER, data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL, compare_price_cents INTEGER, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  condition TEXT NOT NULL DEFAULT 'new', stock INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  featured INTEGER NOT NULL DEFAULT 0, sku TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL, UNIQUE(session_id, product_id));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, user_id INTEGER, email TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', subtotal_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  ship_address TEXT NOT NULL DEFAULT '{}', payment_provider TEXT NOT NULL DEFAULT 'test', payment_ref TEXT,
  tracking TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, shipped_at TEXT);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, name TEXT NOT NULL, unit_cents INTEGER NOT NULL, qty INTEGER NOT NULL, image TEXT);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);
`;

export const DEFAULT_SETTINGS = {
  shop_name: 'Robbins Shop',
  tagline: 'Computer parts, pre-loved goods and clothing',
  tagline_ko: '컴퓨터 부품, 중고 물품, 의류',
  currency: 'usd',
  alt_currency: 'krw', // optional second display currency (prices are converted for display only)
  fx_rate: '', // units of alt_currency per 1 unit of currency, e.g. 1350
  fx_auto: '1', // refresh fx_rate daily from frankfurter.app (ECB rates)
  fx_updated_at: '',
  tax_rate: '0', // percent, e.g. "8.25"
  shipping_flat_cents: '799',
  free_shipping_over_cents: '10000',
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  base_url: '',
  contact_email: '',
};

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  if (!getSetting(db, 'session_secret')) setSetting(db, 'session_secret', randomBytes(32).toString('hex'));
  return db;
}

// Adds columns introduced after v1 to existing databases.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('products', 'name_ko')) db.exec("ALTER TABLE products ADD COLUMN name_ko TEXT NOT NULL DEFAULT ''");
  if (!has('products', 'description_ko')) db.exec("ALTER TABLE products ADD COLUMN description_ko TEXT NOT NULL DEFAULT ''");
  if (!has('categories', 'name_ko')) db.exec("ALTER TABLE categories ADD COLUMN name_ko TEXT NOT NULL DEFAULT ''");
}

// ---- settings ----
export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value ?? ''));
}
export function allSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

// ---- helpers ----
export function slugify(text) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'item';
}
export function uniqueSlug(db, table, base, excludeId = null) {
  let slug = base, n = 2;
  const q = db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id IS NOT ?`);
  while (q.get(slug, excludeId)) slug = `${base}-${n++}`;
  return slug;
}
export function newOrderNumber() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `RS-${ymd}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

// ---- users ----
export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) || null;
}
export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
export function createUser(db, { email, passwordHash, name = '', role = 'customer' }) {
  const r = db.prepare('INSERT INTO users(email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(String(email).trim().toLowerCase(), passwordHash, name, role);
  return findUserById(db, Number(r.lastInsertRowid));
}
export function adminExists(db) {
  return !!db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
}

// ---- sessions ----
export function loadSession(db, id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? { id: row.id, userId: row.user_id, data: JSON.parse(row.data || '{}') } : null;
}
export function saveSession(db, s) {
  db.prepare(`INSERT INTO sessions(id, user_id, data) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, updated_at = datetime('now')`).run(s.id, s.userId ?? null, JSON.stringify(s.data || {}));
}
export function deleteSession(db, id) { db.prepare('DELETE FROM sessions WHERE id = ?').run(id); }
export function purgeOldSessions(db, days = 30) {
  db.prepare(`DELETE FROM sessions WHERE updated_at < datetime('now', ?)`).run(`-${days} days`);
}

// ---- categories ----
export function listCategories(db) { return db.prepare('SELECT * FROM categories ORDER BY position, name').all(); }
export function createCategory(db, name, nameKo = '') {
  const slug = uniqueSlug(db, 'categories', slugify(name));
  const r = db.prepare('INSERT INTO categories(name, slug, name_ko) VALUES (?, ?, ?)').run(name.trim(), slug, String(nameKo || '').trim());
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(r.lastInsertRowid));
}
export function updateCategory(db, id, name, nameKo = '') {
  db.prepare('UPDATE categories SET name = ?, name_ko = ? WHERE id = ?').run(String(name).trim(), String(nameKo || '').trim(), id);
}
export function deleteCategory(db, id) { db.prepare('DELETE FROM categories WHERE id = ?').run(id); }
export function findCategoryBySlug(db, slug) { return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) || null; }

// ---- products ----
const PRODUCT_SELECT = `SELECT p.*, c.name AS category_name, c.name_ko AS category_name_ko, c.slug AS category_slug,
  (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY position, id LIMIT 1) AS image
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

export function createProduct(db, p) {
  const slug = uniqueSlug(db, 'products', slugify(p.slug || p.name));
  const r = db.prepare(`INSERT INTO products(slug, name, description, price_cents, compare_price_cents, category_id, condition, stock, status, featured, sku, name_ko, description_ko)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, p.name, p.description || '', p.price_cents, p.compare_price_cents ?? null,
    p.category_id ?? null, p.condition || 'new', p.stock ?? 0, p.status || 'active', p.featured ? 1 : 0, p.sku || '', p.name_ko || '', p.description_ko || '');
  return getProduct(db, Number(r.lastInsertRowid));
}
export function updateProduct(db, id, p) {
  const cur = getProduct(db, id);
  if (!cur) return null;
  const slug = p.slug !== undefined && slugify(p.slug) !== cur.slug ? uniqueSlug(db, 'products', slugify(p.slug || p.name || cur.name), id) : cur.slug;
  db.prepare(`UPDATE products SET slug = ?, name = ?, description = ?, price_cents = ?, compare_price_cents = ?, category_id = ?, condition = ?,
    stock = ?, status = ?, featured = ?, sku = ?, name_ko = ?, description_ko = ?, updated_at = datetime('now') WHERE id = ?`).run(
    slug, p.name ?? cur.name, p.description ?? cur.description, p.price_cents ?? cur.price_cents, p.compare_price_cents ?? null,
    p.category_id ?? null, p.condition ?? cur.condition, p.stock ?? cur.stock, p.status ?? cur.status, p.featured ? 1 : 0, p.sku ?? cur.sku, p.name_ko ?? cur.name_ko, p.description_ko ?? cur.description_ko, id);
  return getProduct(db, id);
}
export function deleteProduct(db, id) {
  const imgs = listImages(db, id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  return imgs;
}
export function getProduct(db, id) {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  return p ? withImages(db, p) : null;
}
export function getProductBySlug(db, slug) {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ?`).get(slug);
  return p ? withImages(db, p) : null;
}
function withImages(db, p) { p.images = listImages(db, p.id); return p; }
export function listImages(db, productId) {
  return db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id').all(productId);
}
export function addImage(db, productId, filename) {
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_images WHERE product_id = ?').get(productId).p;
  db.prepare('INSERT INTO product_images(product_id, filename, position) VALUES (?, ?, ?)').run(productId, filename, pos);
}
export function deleteImage(db, productId, imageId) {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(imageId, productId);
  if (img) db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId);
  return img || null;
}
export function makePrimaryImage(db, productId, imageId) {
  db.prepare('UPDATE product_images SET position = position + 1 WHERE product_id = ?').run(productId);
  db.prepare('UPDATE product_images SET position = 0 WHERE id = ? AND product_id = ?').run(imageId, productId);
}

/** List products with filters. opts: { q, category (slug), condition, sort, page, perPage, status, featured, inStock, all } */
export function listProducts(db, opts = {}) {
  const where = [], args = [];
  if (!opts.all) { where.push('p.status = ?'); args.push(opts.status || 'active'); }
  else if (opts.status) { where.push('p.status = ?'); args.push(opts.status); }
  if (opts.q) { where.push('(p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ? OR p.name_ko LIKE ? OR p.description_ko LIKE ?)'); const like = `%${opts.q}%`; args.push(like, like, like, like, like); }
  if (opts.category) { where.push('c.slug = ?'); args.push(opts.category); }
  if (opts.condition) { where.push('p.condition = ?'); args.push(opts.condition); }
  if (opts.featured) where.push('p.featured = 1');
  if (opts.inStock) where.push('p.stock > 0');
  const order = { price_asc: 'p.price_cents ASC', price_desc: 'p.price_cents DESC', name: 'p.name ASC', oldest: 'p.created_at ASC' }[opts.sort] || 'p.created_at DESC, p.id DESC';
  const perPage = Math.max(1, Math.min(100, opts.perPage || 24));
  const page = Math.max(1, opts.page || 1);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ${w}`).get(...args).n;
  const items = db.prepare(`${PRODUCT_SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, perPage, (page - 1) * perPage);
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

// ---- cart ----
export function getCart(db, sessionId) {
  return db.prepare(`SELECT ci.product_id, ci.qty, p.name, p.name_ko, p.slug, p.price_cents, p.stock, p.status, p.condition,
    (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY position, id LIMIT 1) AS image
    FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? ORDER BY ci.id`).all(sessionId);
}
export function setCartItem(db, sessionId, productId, qty) {
  if (qty <= 0) return db.prepare('DELETE FROM cart_items WHERE session_id = ? AND product_id = ?').run(sessionId, productId);
  db.prepare(`INSERT INTO cart_items(session_id, product_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(session_id, product_id) DO UPDATE SET qty = excluded.qty`).run(sessionId, productId, qty);
}
export function addToCart(db, sessionId, productId, qty) {
  const cur = db.prepare('SELECT qty FROM cart_items WHERE session_id = ? AND product_id = ?').get(sessionId, productId);
  setCartItem(db, sessionId, productId, (cur ? cur.qty : 0) + qty);
}
export function clearCart(db, sessionId) { db.prepare('DELETE FROM cart_items WHERE session_id = ?').run(sessionId); }
export function cartCount(db, sessionId) {
  return db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM cart_items WHERE session_id = ?').get(sessionId).n;
}

// ---- orders ----
/** Creates a pending order and reserves stock. items: [{product_id, name, unit_cents, qty, image}]. Throws if stock is insufficient. */
export function createOrder(db, o, items) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const r = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ? AND status = 'active'").run(it.qty, it.product_id, it.qty);
      if (r.changes !== 1) { const e = new Error(`Not enough stock for "${it.name}"`); e.code = 'OUT_OF_STOCK'; e.product_id = it.product_id; throw e; }
    }
    const number = newOrderNumber();
    const r = db.prepare(`INSERT INTO orders(number, user_id, email, name, status, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, ship_address, payment_provider)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`).run(number, o.user_id ?? null, o.email, o.name, o.subtotal_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.currency, JSON.stringify(o.ship_address || {}), o.payment_provider || 'test');
    const orderId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items(order_id, product_id, name, unit_cents, qty, image) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) ins.run(orderId, it.product_id, it.name, it.unit_cents, it.qty, it.image || null);
    db.exec('COMMIT');
    return getOrder(db, orderId);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function getOrder(db, id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return o ? hydrateOrder(db, o) : null;
}
export function getOrderByNumber(db, number) {
  const o = db.prepare('SELECT * FROM orders WHERE number = ?').get(number);
  return o ? hydrateOrder(db, o) : null;
}
function hydrateOrder(db, o) {
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  o.ship_address = JSON.parse(o.ship_address || '{}');
  return o;
}
export function setOrderPaymentRef(db, id, ref) { db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(ref, id); }
/** Idempotent: marks a pending order paid. Returns true if the state changed. */
export function markOrderPaid(db, id, paymentRef) {
  const r = db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'), payment_ref = COALESCE(?, payment_ref) WHERE id = ? AND status = 'pending'`).run(paymentRef ?? null, id);
  return r.changes === 1;
}
/** Cancels an order; restocks items if it was pending or paid. */
export function cancelOrder(db, id, newStatus = 'cancelled') {
  db.exec('BEGIN IMMEDIATE');
  try {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o || !['pending', 'paid'].includes(o.status)) { db.exec('ROLLBACK'); return false; }
    for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id)) {
      if (it.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, id);
    db.exec('COMMIT');
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function updateOrderStatus(db, id, status, extra = {}) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('bad status');
  if (status === 'cancelled' || status === 'refunded') return cancelOrder(db, id, status);
  const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
  if (!o) return false;
  if (status === 'paid' && o.status === 'pending') return markOrderPaid(db, id, extra.payment_ref);
  const sets = ['status = ?'], args = [status];
  if (status === 'shipped') sets.push("shipped_at = COALESCE(shipped_at, datetime('now'))");
  if (extra.tracking !== undefined) { sets.push('tracking = ?'); args.push(extra.tracking); }
  if (extra.notes !== undefined) { sets.push('notes = ?'); args.push(extra.notes); }
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return true;
}
export function listOrders(db, opts = {}) {
  const where = [], args = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.user_id) { where.push('user_id = ?'); args.push(opts.user_id); }
  if (opts.q) { where.push('(number LIKE ? OR email LIKE ? OR name LIKE ?)'); const l = `%${opts.q}%`; args.push(l, l, l); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = opts.perPage || 50, page = Math.max(1, opts.page || 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${w}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM orders ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, perPage, (page - 1) * perPage)
    .map((o) => hydrateOrder(db, o));
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}
/** Cancel unpaid orders older than `minutes` and release their stock. Returns count. */
export function expirePendingOrders(db, minutes = 120) {
  const rows = db.prepare(`SELECT id FROM orders WHERE status = 'pending' AND created_at < datetime('now', ?)`).all(`-${minutes} minutes`);
  let n = 0;
  for (const r of rows) if (cancelOrder(db, r.id)) n++;
  return n;
}
export function salesStats(db) {
  const paid = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue FROM orders WHERE status IN ('paid', 'shipped', 'delivered')`).get();
  const pendingShip = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'`).get().n;
  const products = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'active'`).get().n;
  const lowStock = db.prepare(`SELECT id, name, stock FROM products WHERE status = 'active' AND stock <= 2 ORDER BY stock, name LIMIT 10`).all();
  return { orders: paid.orders, revenue: paid.revenue, pendingShip, products, lowStock };
}
