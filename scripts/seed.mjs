// Seeds demo categories and products (with generated placeholder photos) so the shop has something to show.
// Usage: node scripts/seed.mjs [--data-dir ./data] [--admin-email a@b.c --admin-password secret] [--refresh]
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
const CATEGORIES_KO = ['컴퓨터 부품', '중고 물품', '의류'];
const KO = { // Korean names and descriptions for the demo products (keyed by English name)
  'NVIDIA RTX 4070 12GB': ['NVIDIA RTX 4070 12GB 그래픽카드', '거의 사용하지 않은 그래픽카드, 정품 박스와 구성품 포함. 24시간 풀로드 테스트 완료, 아티팩트 없음, 팬 소음 없음.\n\n• 12GB GDDR6X\n• DisplayPort 3개, HDMI 2.1 1개\n• 2슬롯 디자인'],
  'AMD Ryzen 7 5800X': ['AMD 라이젠 7 5800X', '8코어 / 16스레드, AM4 소켓. 업그레이드하면서 정상 작동 시스템에서 분리했습니다. 쿨러 미포함.'],
  'Corsair Vengeance 32GB (2x16) DDR4-3600': ['커세어 벤전스 32GB (2x16) DDR4-3600', '동일 세트 2개, XMP 프로파일 3600MHz CL18 확인 완료.'],
  'Samsung 980 Pro 1TB NVMe SSD': ['삼성 980 Pro 1TB NVMe SSD', 'PCIe 4.0 NVMe 드라이브, 건강 상태 97%, 총 기록량 10TB 미만. 90일 보증.'],
  'ASUS TUF B550-PLUS Motherboard': ['ASUS TUF B550-PLUS 메인보드', 'ATX AM4 메인보드, I/O 쉴드 포함. 최신 BIOS로 업데이트, 라이젠 5000 지원.'],
  'Dell 24" 1080p IPS Monitor (for parts)': ['델 24인치 1080p IPS 모니터 (부품용)', '전원은 켜지지만 10분 후 백라이트가 깜빡입니다. 스탠드와 케이블 포함. 수리 또는 부품용으로 현 상태 그대로 판매합니다.'],
  'Vintage Oak Desk Lamp': ['빈티지 오크 책상 램프', '황동 스위치가 달린 클래식 책상 램프, 새 전선으로 교체. 받침대에 약간의 사용감 있음.'],
  'Nintendo Switch Pro Controller': ['닌텐도 스위치 프로 컨트롤러', '스틱 상태 완벽, 쏠림 없음. USB-C 케이블 포함.'],
  'Kindle Paperwhite (10th gen)': ['킨들 페이퍼화이트 (10세대)', '8GB, 방수 모델. 화면 흠집 없음, 배터리 몇 주 지속.'],
  'Mechanical Keyboard (Cherry MX Brown)': ['기계식 키보드 (체리 MX 갈축)', '텐키리스 배열, PBT 키캡, 분리형 케이블. 모든 키 테스트 완료.'],
  'Patagonia Better Sweater Fleece — M': ['파타고니아 베터 스웨터 플리스 — M', '남성용 M, 네이비. 몇 번만 착용, 보풀 없음.'],
  "Levi's 501 Jeans — 32x32": ['리바이스 501 청바지 — 32x32', '클래식 스트레이트 핏, 미디엄 워싱, 무릎 부분 약간의 탈색.'],
  'Nike Air Zoom Pegasus 40 — US 10': ['나이키 에어 줌 페가수스 40 — US 10', '약 80km 사용, 밑창 거의 닳지 않음. 세척 및 탈취 완료.'],
  'Wool Peacoat — L': ['울 피코트 — L', '두꺼운 차콜 울, 단추 모두 있음, 안감 전체. 드라이클리닝 완료.'],
  'Plain White T-Shirt 3-pack — L': ['무지 흰색 티셔츠 3팩 — L', '새 상품, 태그 있음. 100% 코마사 면, 크루넥.'],
};
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
const refresh = 'refresh' in args || 'refresh-images' in args;
const cats = CATEGORIES.map((n, i) => {
  const c = existing.get(n);
  if (c && refresh && !c.name_ko) db.updateCategory(conn, c.id, c.name, CATEGORIES_KO[i]);
  return c || db.createCategory(conn, n, CATEGORIES_KO[i]);
});
let created = 0;
let refreshed = 0;
for (const p of PRODUCTS) {
  const existing = db.getProductBySlug(conn, db.slugify(p.name));
  const [name_ko, description_ko] = KO[p.name] || ['', ''];
  if (existing) {
    // --refresh: re-render the generated placeholder photos and fill in Korean text of previously seeded products
    if (refresh) {
      for (const img of existing.images) if (img.filename.startsWith('seed-')) { writeFileSync(join(uploads, img.filename), makePng(800, 600, p.color[0], p.color[1])); refreshed++; }
      if (!existing.name_ko) db.updateProduct(conn, existing.id, { ...existing, name_ko, description_ko, featured: existing.featured, slug: existing.slug });
    }
    continue;
  }
  const prod = db.createProduct(conn, { name: p.name, name_ko, description: p.desc, description_ko, price_cents: Math.round(p.price * 100), compare_price_cents: p.compare ? Math.round(p.compare * 100) : null,
    category_id: cats[p.cat].id, condition: p.cond, stock: p.stock, featured: !!p.featured });
  const file = `seed-${prod.slug}.png`;
  writeFileSync(join(uploads, file), makePng(800, 600, p.color[0], p.color[1]));
  db.addImage(conn, prod.id, file);
  created++;
}
console.log(`Seeded ${created} products in ${cats.length} categories (${dataDir})${refreshed ? `, refreshed ${refreshed} images` : ''}`);
conn.close();
