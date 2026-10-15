// Dependency-free PNG encoder for placeholder images (used by the seed script and tests).
import { deflateSync, crc32 } from 'node:zlib';

/** Tiny PNG encoder: solid background with a lighter rectangle "object", no dependencies. */
export function makePng(width, height, [r, g, b], [r2, g2, b2]) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const inner = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
      row[1 + x * 3] = inner ? r2 : r; row[2 + x * 3] = inner ? g2 : g; row[3 + x * 3] = inner ? b2 : b;
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
