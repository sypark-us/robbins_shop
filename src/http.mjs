// Minimal HTTP helpers: routing, cookies, body parsing (urlencoded, JSON, multipart) and responses.
import { extname } from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
export const mimeFor = (file) => MIME[extname(file).toLowerCase()] || 'application/octet-stream';

export class HttpError extends Error {
  constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
}

// ---- cookies ----
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  s += `; SameSite=${opts.sameSite || 'Lax'}`;
  if (opts.secure) s += '; Secure';
  return s;
}

// ---- body parsing ----
export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export function parseUrlEncoded(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(text))) {
    if (k.endsWith('[]')) { const key = k.slice(0, -2); (out[key] ||= []).push(v); }
    else out[k] = v;
  }
  return out;
}

/** Parse multipart/form-data. Returns { fields: {name: value}, files: [{field, filename, type, data}] }. */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new HttpError(400, 'Missing multipart boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {}, files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) return { fields, files };
  pos += boundary.length;
  for (;;) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.subarray(pos, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    let next = buf.indexOf(boundary, bodyStart);
    if (next < 0) break;
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const body = buf.subarray(bodyStart, bodyEnd);
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head);
    const params = {};
    if (disp) for (const mm of disp[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) params[mm[1]] = mm[2].replace(/\\"/g, '"');
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (params.filename !== undefined) {
      if (params.filename) files.push({ field: params.name.replace(/\[\]$/, ''), filename: params.filename, type: ctype ? ctype[1].trim() : 'application/octet-stream', data: Buffer.from(body) });
    } else if (params.name) {
      const v = body.toString('utf8');
      if (params.name.endsWith('[]')) (fields[params.name.slice(0, -2)] ||= []).push(v); else fields[params.name] = v;
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

/** Reads and parses a request body according to its content type. */
export async function parseBody(req, { limit = 1024 * 1024, fileLimit = 30 * 1024 * 1024 } = {}) {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    const buf = await readBody(req, fileLimit);
    return parseMultipart(buf, ct);
  }
  const buf = await readBody(req, limit);
  if (ct.startsWith('application/json')) {
    try { return { fields: JSON.parse(buf.toString('utf8') || '{}'), files: [], raw: buf }; } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  return { fields: parseUrlEncoded(buf.toString('utf8')), files: [], raw: buf };
}

// ---- router ----
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*$/, '.*') + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

// ---- responses ----
export function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
export const html = (res, body, status = 200, headers = {}) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
export const json = (res, obj, status = 200, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
export const redirect = (res, location, status = 303) => { res.writeHead(status, { Location: location }); res.end(); };

// ---- security helpers ----
export function safeImageType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) return '.gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}
