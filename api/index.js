// Vercel serverless entry point. vercel.json rewrites /api/<route> here as ?route=<route>.
import fs from 'node:fs';
import path from 'node:path';
import { createApi, supabaseStore } from '../shared/api.js';

const env = process.env;
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(process.cwd(), f), 'utf8'));
const config = readJSON('config.json');
const samples = env.SAMPLE_TOOLS === 'off' ? null : readJSON('samples.json');
const handle = createApi({
  store: supabaseStore({ url: env.SUPABASE_URL, apiKey: env.SUPABASE_KEY, serverKey: env.RIC_SERVER_KEY, eventId: env.EVENT_ID || 'main' }),
  config, samples, env,
});

export default async function (req, res) {
  const { route = '', ...query } = req.query || {};
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const [status, json] = await handle({ method: req.method, route: String(route), query, headers: req.headers, body });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (json == null) return res.status(status).end();
  res.status(status).json(json);
}
