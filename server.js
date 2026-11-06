// Innovation Challenge — local server.
// Zero dependencies. Uses a JSON file for storage, or Supabase when SUPABASE_URL is set (same as on Vercel).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, fileStore, supabaseStore } from './shared/api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || '0.0.0.0';
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const config = readJSON('config.json');
const samples = env.SAMPLE_TOOLS === 'off' ? null : readJSON('samples.json');
const store = env.SUPABASE_URL
  ? supabaseStore({ url: env.SUPABASE_URL, apiKey: env.SUPABASE_KEY, serverKey: env.RIC_SERVER_KEY, eventId: env.EVENT_ID })
  : fileStore(fs, path.join(env.DATA_DIR || path.join(ROOT, 'data'), 'state.json'));
const handle = createApi({ store, config, samples, env });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(ROOT, 'public');
const STATIC = { '/shared/logic.js': path.join(ROOT, 'shared/logic.js') };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body == null ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.setEncoding('utf8');
    req.on('data', (c) => { d += c; if (d.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const [status, json] = await handle({ method: req.method, route: p.slice(5), query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    return send(res, status, json);
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  let file = STATIC[p] || path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!STATIC[p] && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, buf) => (err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream')));
}).listen(PORT, HOST, async () => {
  await handle({ method: 'POST', route: 'login', body: { code: '' } }); // creates the event on first run
  const S = (await store.load()).state;
  const pad = (x) => x.padEnd(16);
  console.log(`\n  Innovation Challenge is running on http://localhost:${PORT}  (${env.SUPABASE_URL ? 'Supabase' : 'local file'} storage)\n`);
  console.log('  Sign-in codes (also on the facilitator\'s "Sign-in codes" tab):');
  console.log(`    ${pad('Facilitator')}${env.FACILITATOR_CODE || S.auth.facilitator}`);
  console.log(`    ${pad('Projector')}${env.PROJECTOR_CODE || S.auth.projector}`);
  S.panelists.forEach((j) => console.log(`    ${pad(j.name)}${j.code}`));
  S.teams.forEach((t) => console.log(`    ${pad(t.name)}${t.code}`));
  console.log('');
});
