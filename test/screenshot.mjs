// Takes screenshots of key pages with headless Chrome/Edge into ./screenshots (uses the data dir, so run `npm run seed` first).
// Usage: node test/screenshot.mjs [path-to-chrome]   (set ADMIN_EMAIL/ADMIN_PASSWORD to also capture the admin pages)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';

const PORT = 8139, CDP = 9339;
const candidates = [process.argv[2], process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(2); }

const app = createApp({ log: () => {} });
const server = createServer(app.handler).listen(PORT);
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars', '--window-size=1280,900', `--remote-debugging-port=${CDP}`, `--user-data-dir=${process.env.TEMP || '/tmp'}/rs-shot-profile`, 'about:blank'], { stdio: 'ignore' });
let done = false;
const cleanup = () => { if (done) return; done = true; try { browser.kill(); } catch { /* ignore */ } server.close(); app.close(); };
process.on('exit', cleanup);

let targets = null;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { await delay(200); } }
if (!targets) { console.error('Could not connect to DevTools'); process.exit(2); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const navigate = async (path, wait = 700) => { await send('Page.navigate', { url: `http://localhost:${PORT}${path}` }); await delay(wait); };
const shoot = async (name, path) => {
  await navigate(path);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`screenshots/${name}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved screenshots/${name}.png`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
mkdirSync('screenshots', { recursive: true });
const first = app.db.prepare("SELECT slug FROM products WHERE status='active' AND stock > 0 ORDER BY featured DESC, id LIMIT 1").get();

await shoot('home', '/');
await shoot('shop', '/shop');
await shoot('login', '/login');
if (first) {
  await shoot('product', `/p/${first.slug}`);
  await evaluate("document.querySelector('.add-form').submit(); 'ok'");
  await delay(900);
  await shoot('cart', '/cart');
  await shoot('checkout', '/checkout');
}
await shoot('home-ko', '/?lang=ko');
if (first) await shoot('product-ko', `/p/${first.slug}`);
await shoot('cart-krw', '/cart?lang=en&cur=krw');
await navigate('/?lang=en&cur=usd');
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  await navigate('/login');
  await evaluate(`const f = document.querySelector('form[action^="/login"]'); f.email.value = ${JSON.stringify(process.env.ADMIN_EMAIL)}; f.password.value = ${JSON.stringify(process.env.ADMIN_PASSWORD)}; f.submit(); 'ok'`);
  await delay(1000);
  for (const [name, path] of [['admin-dashboard', '/admin'], ['admin-products', '/admin/products'], ['admin-product-new', '/admin/products/new'], ['admin-orders', '/admin/orders'], ['admin-settings', '/admin/settings']]) await shoot(name, path);
}
ws.close();
cleanup();
process.exit(0);
