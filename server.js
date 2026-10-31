// Retail Innovation Challenge — live server.
// Zero dependencies: Node's http module, Server-Sent Events for live sync, a JSON file for persistence.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, identify, redact, apply, isUserError } from './shared/logic.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ALLOW_SAMPLES = process.env.SAMPLE_TOOLS !== 'off';

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const config = readJSON(path.join(ROOT, 'config.json'));
if (process.env.FACILITATOR_CODE) config.facilitatorCode = process.env.FACILITATOR_CODE;
if (process.env.PANEL_CODE) config.panelCode = process.env.PANEL_CODE;
if (process.env.PROJECTOR_CODE) config.projectorCode = process.env.PROJECTOR_CODE;
const samples = ALLOW_SAMPLES ? readJSON(path.join(ROOT, 'samples.json')) : null;

/* ---------- state + persistence ---------- */
let S;
try { S = readJSON(STATE_FILE); console.log(`Loaded saved event from ${STATE_FILE}`); }
catch { S = createState(config); }
if (process.env.FACILITATOR_CODE) S.auth.facilitator = process.env.FACILITATOR_CODE;
if (process.env.PANEL_CODE) S.auth.panel = process.env.PANEL_CODE;
if (process.env.PROJECTOR_CODE) S.auth.projector = process.env.PROJECTOR_CODE;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    fs.renameSync(tmp, STATE_FILE);
  }, 150);
}
save();

/* ---------- live clients ---------- */
const clients = new Set();
const frame = (me) => `event: state\ndata: ${JSON.stringify({ state: redact(S, me), me, now: Date.now(), samples: !!samples })}\n\n`;
function broadcast() { for (const c of clients) c.res.write(frame(c.me)); }
setInterval(() => { for (const c of clients) c.res.write(`: ping ${Date.now()}\n\n`); }, 20000);

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const STATIC = { '/shared/logic.js': path.join(ROOT, 'shared/logic.js') };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.setEncoding('utf8');
    req.on('data', (c) => { d += c; if (d.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/login' && req.method === 'POST') {
      const { code } = await readBody(req);
      const me = identify(S, code);
      return me ? send(res, 200, { me }) : send(res, 401, { error: 'That code was not recognised.' });
    }
    if (p === '/api/events' && req.method === 'GET') {
      const me = identify(S, url.searchParams.get('code'));
      if (!me) return send(res, 401, { error: 'Sign in again.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const c = { res, me }; clients.add(c);
      res.write('retry: 2000\n\n'); res.write(frame(me));
      req.on('close', () => clients.delete(c));
      return;
    }
    if (p === '/api/action' && req.method === 'POST') {
      const me = identify(S, req.headers['x-code']);
      if (!me) return send(res, 401, { error: 'Sign in again.' });
      const a = await readBody(req);
      const before = JSON.stringify(S);
      try {
        const out = apply(S, me, a, Date.now(), samples) || {};
        if (JSON.stringify(S) !== before) { save(); broadcast(); }
        return send(res, 200, { ok: true, ...out });
      } catch (e) {
        S = JSON.parse(before); // never keep a half-applied change
        if (isUserError(e)) return send(res, 400, { error: e.message });
        throw e;
      }
    }
    if (p === '/api/health') return send(res, 200, { ok: true, clients: clients.size, phase: S.phase });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    if (STATIC[p]) return serveFile(res, STATIC[p]);
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    if (!fs.existsSync(file)) return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    return serveFile(res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  const pad = (s) => s.padEnd(16);
  console.log(`\n  ${S.event.title} is running on http://localhost:${PORT}\n`);
  console.log('  Sign-in codes (also shown on the facilitator screen):');
  console.log(`    ${pad('Facilitator')}${S.auth.facilitator}`);
  console.log(`    ${pad('Review panel')}${S.auth.panel}`);
  console.log(`    ${pad('Projector')}${S.auth.projector}`);
  S.judges.forEach((j) => console.log(`    ${pad(j.name)}${j.code}`));
  S.teams.forEach((t) => console.log(`    ${pad(t.name)}${t.code}`));
  console.log('');
});
