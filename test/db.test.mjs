import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.mjs';

const fresh = () => db.openDb(':memory:');

test('settings have defaults and a generated session secret', () => {
  const c = fresh();
  const s = db.allSettings(c);
  assert.equal(s.currency, 'usd');
  assert.match(db.getSetting(c, 'session_secret'), /^[0-9a-f]{64}$/);
  db.setSetting(c, 'shop_name', 'My Shop');
  assert.equal(db.allSettings(c).shop_name, 'My Shop');
});

test('slugs are unique and clean', () => {
  const c = fresh();
  assert.equal(db.slugify('  Hello, World! 2024 '), 'hello-world-2024');
  assert.equal(db.slugify('!!!'), 'item');
  const a = db.createProduct(c, { name: 'RTX 4070', price_cents: 1 });
  const b = db.createProduct(c, { name: 'RTX 4070', price_cents: 1 });
  assert.equal(a.slug, 'rtx-4070');
  assert.equal(b.slug, 'rtx-4070-2');
  const u = db.updateProduct(c, b.id, { ...b, slug: 'rtx-4070' });
  assert.equal(u.slug, 'rtx-4070-2', 'cannot steal an existing slug');
});

test('product listing filters, search, pagination and images', () => {
  const c = fresh();
  const parts = db.createCategory(c, 'Computer parts');
  const clothes = db.createCategory(c, 'Clothing');
  for (let i = 0; i < 30; i++) db.createProduct(c, { name: `Part ${i}`, price_cents: 100 * (i + 1), category_id: parts.id, condition: i % 2 ? 'used' : 'new', stock: i % 5 });
  db.createProduct(c, { name: 'Jacket', price_cents: 5000, category_id: clothes.id, status: 'draft', stock: 1 });
  db.createProduct(c, { name: 'Shirt', description: 'cotton tee', price_cents: 1500, category_id: clothes.id, stock: 1, featured: true });
  assert.equal(db.listProducts(c).total, 31, 'drafts hidden by default');
  assert.equal(db.listProducts(c, { all: true }).total, 32);
  assert.equal(db.listProducts(c, { category: 'clothing' }).total, 1);
  assert.equal(db.listProducts(c, { condition: 'used' }).total, 15);
  assert.equal(db.listProducts(c, { q: 'cotton' }).items[0].name, 'Shirt');
  assert.equal(db.listProducts(c, { featured: true }).total, 1);
  const page2 = db.listProducts(c, { perPage: 10, page: 2 });
  assert.equal(page2.items.length, 10); assert.equal(page2.pages, 4);
  assert.equal(db.listProducts(c, { sort: 'price_asc' }).items[0].price_cents, 100);
  const shirt = db.getProductBySlug(c, 'shirt');
  db.addImage(c, shirt.id, 'a.png'); db.addImage(c, shirt.id, 'b.png');
  assert.equal(db.getProduct(c, shirt.id).image, 'a.png');
  const imgs = db.listImages(c, shirt.id);
  db.makePrimaryImage(c, shirt.id, imgs[1].id);
  assert.equal(db.getProduct(c, shirt.id).image, 'b.png');
  assert.equal(db.deleteImage(c, shirt.id, imgs[0].id).filename, 'a.png');
  assert.equal(db.deleteImage(c, shirt.id, 9999), null);
  const removed = db.deleteProduct(c, shirt.id);
  assert.deepEqual(removed.map((i) => i.filename), ['b.png']);
  assert.equal(db.getProduct(c, shirt.id), null);
  db.deleteCategory(c, clothes.id);
  assert.equal(db.getProductBySlug(c, 'jacket').category_id, null, 'category delete nulls products');
});

test('cart and order lifecycle with stock reservation', () => {
  const c = fresh();
  const p = db.createProduct(c, { name: 'SSD', price_cents: 7900, stock: 2 });
  const sid = 'sess1';
  db.addToCart(c, sid, p.id, 1); db.addToCart(c, sid, p.id, 1);
  assert.equal(db.cartCount(c, sid), 2);
  assert.equal(db.getCart(c, sid)[0].qty, 2);
  const o = db.createOrder(c, { email: 'a@b.co', name: 'A', subtotal_cents: 15800, shipping_cents: 0, tax_cents: 0, total_cents: 15800, currency: 'usd', ship_address: { city: 'X' } },
    [{ product_id: p.id, name: 'SSD', unit_cents: 7900, qty: 2 }]);
  assert.match(o.number, /^RS-\d{8}-[0-9A-F]{6}$/);
  assert.equal(o.status, 'pending');
  assert.equal(db.getProduct(c, p.id).stock, 0, 'stock reserved at order creation');
  assert.throws(() => db.createOrder(c, { email: 'a@b.co', name: 'A', subtotal_cents: 1, shipping_cents: 0, tax_cents: 0, total_cents: 1, currency: 'usd' }, [{ product_id: p.id, name: 'SSD', unit_cents: 7900, qty: 1 }]), /stock/);
  assert.equal(db.listOrders(c).total, 1, 'failed order rolled back');
  assert.ok(db.markOrderPaid(c, o.id, 'pi_1'));
  assert.ok(!db.markOrderPaid(c, o.id, 'pi_1'), 'idempotent');
  assert.equal(db.getOrder(c, o.id).payment_ref, 'pi_1');
  db.updateOrderStatus(c, o.id, 'shipped', { tracking: '1Z999' });
  const shipped = db.getOrder(c, o.id);
  assert.equal(shipped.tracking, '1Z999'); assert.ok(shipped.shipped_at);
  assert.ok(db.cancelOrder(c, o.id, 'refunded') === false, 'shipped orders are not restocked by cancel');
  db.updateOrderStatus(c, o.id, 'paid');
  assert.equal(db.getOrder(c, o.id).status, 'paid');
  assert.ok(db.updateOrderStatus(c, o.id, 'refunded'));
  assert.equal(db.getProduct(c, p.id).stock, 2, 'refund restocks');
  assert.equal(db.getOrderByNumber(c, o.number).status, 'refunded');
  const stats = db.salesStats(c);
  assert.equal(stats.orders, 0);
  db.clearCart(c, sid);
  assert.equal(db.cartCount(c, sid), 0);
});

test('expirePendingOrders restocks stale orders only', () => {
  const c = fresh();
  const p = db.createProduct(c, { name: 'X', price_cents: 100, stock: 1 });
  const o = db.createOrder(c, { email: 'a@b.co', name: 'A', subtotal_cents: 100, shipping_cents: 0, tax_cents: 0, total_cents: 100, currency: 'usd' }, [{ product_id: p.id, name: 'X', unit_cents: 100, qty: 1 }]);
  assert.equal(db.expirePendingOrders(c, 120), 0);
  c.prepare("UPDATE orders SET created_at = datetime('now', '-3 hours') WHERE id = ?").run(o.id);
  assert.equal(db.expirePendingOrders(c, 120), 1);
  assert.equal(db.getProduct(c, p.id).stock, 1);
  assert.equal(db.getOrder(c, o.id).status, 'cancelled');
});

test('users and sessions', () => {
  const c = fresh();
  assert.ok(!db.adminExists(c));
  const u = db.createUser(c, { email: ' Admin@Example.com ', passwordHash: 'h', role: 'admin' });
  assert.equal(u.email, 'admin@example.com');
  assert.ok(db.adminExists(c));
  assert.equal(db.findUserByEmail(c, 'ADMIN@example.com').id, u.id);
  db.saveSession(c, { id: 's1', userId: u.id, data: { csrf: 'x' } });
  assert.deepEqual(db.loadSession(c, 's1'), { id: 's1', userId: u.id, data: { csrf: 'x' } });
  db.deleteSession(c, 's1');
  assert.equal(db.loadSession(c, 's1'), null);
});
