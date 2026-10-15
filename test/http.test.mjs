import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart, parseCookies, serializeCookie, parseUrlEncoded, Router, safeImageType } from '../src/http.mjs';

test('parseMultipart extracts fields and files', () => {
  const b = 'XyZ123';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x0d, 0x0a, 0x2d, 0x2d]);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="name"\r\n\r\nWidget "deluxe"\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="tags[]"\r\n\r\na\r\n--${b}\r\nContent-Disposition: form-data; name="tags[]"\r\n\r\nb\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="images[]"; filename="p1.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n'),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="images[]"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const r = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(r.fields.name, 'Widget "deluxe"');
  assert.deepEqual(r.fields.tags, ['a', 'b']);
  assert.equal(r.files.length, 1, 'empty filename parts are skipped');
  assert.equal(r.files[0].field, 'images');
  assert.equal(r.files[0].filename, 'p1.png');
  assert.equal(r.files[0].type, 'image/png');
  assert.ok(r.files[0].data.equals(png), 'binary content preserved exactly');
});

test('parseMultipart rejects missing boundary', () => {
  assert.throws(() => parseMultipart(Buffer.alloc(0), 'multipart/form-data'), /boundary/);
});

test('cookies round-trip', () => {
  const c = serializeCookie('sid', 'a b.c', { maxAge: 10, secure: true });
  assert.match(c, /^sid=a%20b\.c; Path=\/; Max-Age=10; HttpOnly; SameSite=Lax; Secure$/);
  assert.deepEqual(parseCookies('sid=a%20b.c; other=1'), { sid: 'a b.c', other: '1' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('parseUrlEncoded supports arrays', () => {
  assert.deepEqual(parseUrlEncoded('a=1&b[]=x&b[]=y&c=%20'), { a: '1', b: ['x', 'y'], c: ' ' });
});

test('Router matches params and HEAD', () => {
  const r = new Router().get('/p/:slug', 'prod').post('/admin/products/:id/images/:img', 'img').get('/static/*', 'st');
  assert.deepEqual(r.match('GET', '/p/my-item').params, { slug: 'my-item' });
  assert.equal(r.match('HEAD', '/p/x').handler, 'prod');
  assert.deepEqual(r.match('POST', '/admin/products/5/images/9/').params, { id: '5', img: '9' });
  assert.equal(r.match('GET', '/static/a/b.css').handler, 'st');
  assert.equal(r.match('POST', '/p/x'), null);
  assert.equal(r.match('GET', '/p/a/b'), null);
});

test('safeImageType sniffs magic bytes', () => {
  assert.equal(safeImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), '.png');
  assert.equal(safeImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), '.jpg');
  assert.equal(safeImageType(Buffer.from('GIF89a......')), '.gif');
  assert.equal(safeImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), '.webp');
  assert.equal(safeImageType(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(safeImageType(Buffer.from('MZ')), null);
});
