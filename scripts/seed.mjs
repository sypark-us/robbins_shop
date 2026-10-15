// Seeds demo categories and products (with generated placeholder photos) so the shop has something to show.
// Usage: node scripts/seed.mjs [--data-dir ./data] [--admin-email a@b.c --admin-password secret]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as db from '../src/db.mjs';
import { makePng } from '../src/png.mjs';
import { hashPassword } from '../src/auth.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((x) => x.length));
const dataDir = resolve(args['data-dir'] || process.env.DATA_DIR || 'data');
const uploads = join(dataDir, 'uploads');
mkdirSync(uploads, { recursive: true });
const conn = db.openDb(join(dataDir, 'shop.db'));

const CATEGORIES = ['Computer parts', 'Used items', 'Clothing'];
const PRODUCTS = [
  { cat: 0, name: 'NVIDIA RTX 4070 12GB', price: 489.0, compare: 549.0, cond: 'like_new', stock: 2, featured: 1, color: [[30, 60, 40], [90, 200, 120]], desc: 'Barely used graphics card, original box and accessories included. Tested under full load for 24h, no artifacts, fans silent.\n\n• 12GB GDDR6X\n• 3x DisplayPort, 1x HDMI 2.1\n• 2-slot design' },
  { cat: 0, name: 'AMD Ryzen 7 5800X', price: 169.0, cond: 'used', stock: 3, color: [[60, 30, 30], [220, 90, 70]], desc: '8 cores / 16 threads, AM4 socket. Pulled from a working system during an upgrade. No cooler included.' },
  { cat: 0, name: 'Corsair Vengeance 32GB (2x16) DDR4-3600', price: 59.0, cond: 'used', stock: 4, color: [[40, 40, 40], [160, 160, 170]], desc: 'Two matched sticks, XMP profile verified at 3600MHz CL18.' },
  { cat: 0, name: 'Samsung 980 Pro 1TB NVMe SSD', price: 79.0, cond: 'refurbished', stock: 5, featured: 1, color: [[20, 30, 60], [80, 140, 240]], desc: 'PCIe 4.0 NVMe drive, 97% health, under 10TB written. 90-day warranty.' },
  { cat: 0, name: 'ASUS TUF B550-PLUS Motherboard', price: 95.0, cond: 'used', stock: 1, color: [[25, 25, 25], [200, 170, 60]], desc: 'ATX AM4 motherboard with I/O shield. BIOS updated to latest version, supports Ryzen 5000.' },
  { cat: 0, name: 'Dell 24" 1080p IPS Monitor (for parts)', price: 25.0, cond: 'for_parts', stock: 1, color: [[50, 50, 60], [20, 20, 25]], desc: 'Powers on but backlight flickers after 10 minutes. Stand and cables included. Sold as-is for repair or parts.' },
  { cat: 1, name: 'Vintage Oak Desk Lamp', price: 35.0, cond: 'used', stock: 1, featured: 1, color: [[70, 50, 30], [230, 190, 120]], desc: 'Classic desk lamp with brass switch, rewired with a new cord. Minor wear on the base.' },
  { cat: 1, name: 'Nintendo Switch Pro Controller', price: 42.0, cond: 'like_new', stock: 2, color: [[30, 30, 30], [100, 100, 110]], desc: 'Perfect sticks, no drift. Comes with USB-C cable.' },
  { cat: 1, name: 'Kindle Paperwhite (10th gen)', price: 55.0, cond: 'used', stock: 1, color: [[40, 40, 45], [230, 230, 225]], desc: '8GB, waterproof model. Screen flawless, battery holds a charge for weeks.' },
  { cat: 1, name: 'Mechanical Keyboard (Cherry MX Brown)', price: 48.0, cond: 'used', stock: 2, color: [[35, 35, 35], [180, 120, 80]], desc: 'Tenkeyless layout, PBT keycaps, detachable cable. All keys tested.' },
  { cat: 2, name: 'Patagonia Better Sweater Fleece — M', price: 65.0, compare: 139.0, cond: 'like_new', stock: 1, featured: 1, color: [[30, 50, 70], [60, 110, 150]], desc: 'Men\'s medium, navy. Worn a handful of times, no pilling.' },
  { cat: 2, name: 'Levi\'s 501 Jeans — 32x32', price: 28.0, cond: 'used', stock: 1, color: [[25, 35, 60], [70, 90, 140]], desc: 'Classic straight fit, medium wash, light fading at the knees.' },
  { cat: 2, name: 'Nike Air Zoom Pegasus 40 — US 10', price: 70.0, cond: 'used', stock: 1, color: [[40, 40, 40], [240, 90, 60]], desc: 'About 50 miles on them, tread barely worn. Cleaned and deodorized.' },
  { cat: 2, name: 'Wool Peacoat — L', price: 85.0, cond: 'used', stock: 1, color: [[30, 30, 35], [90, 90, 100]], desc: 'Heavy charcoal wool, all buttons present, fully lined. Dry-cleaned.' },
  { cat: 2, name: 'Plain White T-Shirt 3-pack — L', price: 15.0, cond: 'new', stock: 20, color: [[200, 200, 200], [250, 250, 250]], desc: 'New with tags. 100% combed cotton, crew neck.' },
];

if (args['admin-email'] && args['admin-password'] && !db.adminExists(conn)) {
  db.createUser(conn, { email: args['admin-email'], passwordHash: hashPassword(args['admin-password']), name: 'Admin', role: 'admin' });
  console.log(`Admin ${args['admin-email']} created`);
}

const existing = new Map(db.listCategories(conn).map((c) => [c.name, c]));
const cats = CATEGORIES.map((n) => existing.get(n) || db.createCategory(conn, n));
let created = 0;
let refreshed = 0;
for (const p of PRODUCTS) {
  const existing = db.getProductBySlug(conn, db.slugify(p.name));
  if (existing) {
    // --refresh-images: re-render the generated placeholder photos of previously seeded products
    if ('refresh-images' in args) for (const img of existing.images) if (img.filename.startsWith('seed-')) { writeFileSync(join(uploads, img.filename), makePng(800, 600, p.color[0], p.color[1])); refreshed++; }
    continue;
  }
  const prod = db.createProduct(conn, { name: p.name, description: p.desc, price_cents: Math.round(p.price * 100), compare_price_cents: p.compare ? Math.round(p.compare * 100) : null,
    category_id: cats[p.cat].id, condition: p.cond, stock: p.stock, featured: !!p.featured });
  const file = `seed-${prod.slug}.png`;
  writeFileSync(join(uploads, file), makePng(800, 600, p.color[0], p.color[1]));
  db.addImage(conn, prod.id, file);
  created++;
}
console.log(`Seeded ${created} products in ${cats.length} categories (${dataDir})${refreshed ? `, refreshed ${refreshed} images` : ''}`);
conn.close();
