// Entry point: loads .env (if present), builds the app and listens.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from './src/app.mjs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const app = createApp();
const server = createServer(app.handler);
server.listen(port, host, () => {
  console.log(`${new Date().toISOString()} Robbins Shop listening on http://localhost:${port}  (data: ${app.dataDir})`);
  if (!process.env.STRIPE_SECRET_KEY && !app.db.prepare("SELECT value FROM settings WHERE key='stripe_secret_key'").get()?.value) {
    console.log('Payments: TEST MODE (set STRIPE_SECRET_KEY or configure it in /admin/settings for real payments)');
  }
});
const shutdown = () => { server.close(); app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
