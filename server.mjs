// Entry point: loads .env (if present), builds the app and listens.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Robbins Shop needs Node.js 22.5 or newer (built-in SQLite). You have ${process.versions.node}.\nDownload the current LTS from https://nodejs.org and run "npm start" again.`);
  process.exit(1);
}
const { createApp } = await import('./src/app.mjs');

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
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Stop the other program or start with a different port, e.g.  set PORT=3001 && npm start`);
  else if (e.code === 'EACCES') console.error(`No permission to listen on port ${port}. Try a port above 1024, e.g.  set PORT=3001 && npm start`);
  else console.error('Server error:', e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`${new Date().toISOString()} Robbins Shop listening on http://localhost:${port}  (data: ${app.dataDir})`);
  if (!process.env.STRIPE_SECRET_KEY && !app.db.prepare("SELECT value FROM settings WHERE key='stripe_secret_key'").get()?.value) {
    console.log('Payments: TEST MODE (set STRIPE_SECRET_KEY or configure it in /admin/settings for real payments)');
  }
});
const shutdown = () => { server.close(); app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
