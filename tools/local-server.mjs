#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalD1 } from './local-db.mjs';
import worker from '../src/worker.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
function valueArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const port = Number(valueArg('--port', process.env.PORT || 8788));
const dbPath = path.resolve(valueArg('--db', path.join(root, '.local/shawa-ceo.sqlite')));

if (!fs.existsSync(dbPath)) {
  execFileSync(process.execPath, [path.join(root, 'tools/seed-db.mjs'), '--db', dbPath], { stdio: 'inherit' });
}

const db = new LocalD1(dbPath);
const publicDir = path.join(root, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

async function assetsFetch(request) {
  const url = new URL(request.url);
  let filePath = path.normalize(path.join(publicDir, url.pathname));
  if (!filePath.startsWith(publicDir)) return new Response('Forbidden', { status: 403 });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(publicDir, 'index.html');
  const type = mime[path.extname(filePath)] || 'application/octet-stream';
  return new Response(fs.readFileSync(filePath), { headers: { 'content-type': type } });
}

const env = { DB: db, ASSETS: { fetch: assetsFetch }, APP_TIME_ZONE: 'America/New_York' };
// Tests point this at a local mock Clover; production leaves it unset and the
// worker defaults to https://api.clover.com.
if (process.env.CLOVER_API_BASE) env.CLOVER_API_BASE = process.env.CLOVER_API_BASE;
if (process.env.INVOICE_INBOUND_SECRET) env.INVOICE_INBOUND_SECRET = process.env.INVOICE_INBOUND_SECRET;
if (process.env.OPS_ALERT_SECRET) env.OPS_ALERT_SECRET = process.env.OPS_ALERT_SECRET;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const request = new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer
    });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Local server error: ${error.message}`);
  }
});

server.listen(port, () => {
  console.log(`SHAWA CEO local server: http://localhost:${port}`);
  console.log(`SQLite DB: ${dbPath}`);
});
