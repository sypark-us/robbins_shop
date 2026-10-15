// Dependency-free PNG encoder for placeholder product photos (used by the seed script and tests).
import { deflateSync, crc32 } from 'node:zlib';

/**
 * Renders a studio-style placeholder: soft radial background in `bg`, a centered rounded "product" block in `fg`
 * with a top highlight and a drop shadow. Returns a PNG buffer.
 */
export function makePng(width, height, bg, fg) {
  const [r, g, b] = bg, [r2, g2, b2] = fg;
  const rows = [];
  const cx = width / 2, cy = height / 2;
  const bw = width * 0.46, bh = height * 0.5, rad = Math.min(bw, bh) * 0.18;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const inRound = (x, y, w, h, rr) => {
    const dx = Math.max(Math.abs(x - cx) - (w / 2 - rr), 0), dy = Math.max(Math.abs(y - cy) - (h / 2 - rr), 0);
    return Math.hypot(dx, dy) - rr; // signed distance (<0 inside)
  };
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const d = Math.hypot((x - cx) / width, (y - cy) / height) * 1.6; // 0 center .. ~1.1 corners
      let pr = r + (255 - r) * 0.35 * (1 - d), pg = g + (255 - g) * 0.35 * (1 - d), pb = b + (255 - b) * 0.35 * (1 - d);
      const sd = inRound(x, y + height * 0.06, bw * 1.04, bh * 1.04, rad); // shadow
      if (sd < 24) { const a = Math.max(0, Math.min(1, (24 - sd) / 24)) * 0.35; pr *= 1 - a; pg *= 1 - a; pb *= 1 - a; }
      const d2 = inRound(x, y, bw, bh, rad);
      if (d2 < 0.8) {
        const t = (y - (cy - bh / 2)) / bh; // 0 top .. 1 bottom
        const light = 1.18 - 0.36 * t;
        const edge = Math.max(0, Math.min(1, 0.8 - d2));
        const fr = clamp(r2 * light), fgc = clamp(g2 * light), fb = clamp(b2 * light);
        pr = pr + (fr - pr) * edge; pg = pg + (fgc - pg) * edge; pb = pb + (fb - pb) * edge;
        const gloss = t < 0.12 ? (0.12 - t) / 0.12 * 0.25 : 0;
        pr += (255 - pr) * gloss; pg += (255 - pg) * gloss; pb += (255 - pb) * gloss;
      }
      row[1 + x * 3] = clamp(pr); row[2 + x * 3] = clamp(pg); row[3 + x * 3] = clamp(pb);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
