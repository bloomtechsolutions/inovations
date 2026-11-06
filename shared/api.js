// HTTP API shared by the local server (server.js) and the Vercel function (api/index.js).
import { createState, identify, redact, apply, isUserError } from './logic.js';
import { AiError } from './ai.js';

/** Codes set in the environment always win over stored ones. */
function withEnv(S, env) {
  if (env.FACILITATOR_CODE) S.auth.facilitator = env.FACILITATOR_CODE;
  if (env.PROJECTOR_CODE) S.auth.projector = env.PROJECTOR_CODE;
  return S;
}

/**
 * store: { load(): {state, version} | null, init(state): {state, version}, cas(state, version): newVersion | null, version(): number | null }
 */
export function createApi({ store, config, samples, env = {}, ai = null }) {
  async function current() {
    let row = await store.load();
    if (!row) row = await store.init(withEnv(createState(config), env));
    withEnv(row.state, env);
    return row;
  }
  const frame = (row, me) => ({ state: redact(row.state, me), me, version: row.version, now: Date.now(), samples: !!samples, ai: !!ai });

  /** Validates and applies an action, retrying on concurrent writes. Returns [status, json, fullState?]. */
  async function runAction(code, body) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await current();
      const me = identify(row.state, code);
      if (!me) return [401, { error: 'Sign in again.' }];
      const S = structuredClone(row.state);
      const before = JSON.stringify(S);
      let out;
      try { out = apply(S, me, body, Date.now(), samples) || {}; }
      catch (e) { if (isUserError(e)) return [400, { error: e.message }]; throw e; }
      if (JSON.stringify(S) === before) return [200, { ok: true, ...out, ...frame(row, me) }, S, me];
      const v = await store.cas(S, row.version);
      if (v != null) return [200, { ok: true, ...out, ...frame({ state: S, version: v }, me) }, S, me];
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 120)); // someone else wrote first: retry on fresh state
    }
    return [409, { error: 'Busy. Please try again.' }];
  }

  return async function handle({ method, route, query = {}, headers = {}, body = {} }) {
    try {
      if (route === 'login' && method === 'POST') {
        const row = await current();
        const me = identify(row.state, body.code);
        return me ? [200, { me }] : [401, { error: 'That code was not recognised.' }];
      }
      if (route === 'state' && method === 'GET') {
        if (query.v) {
          const v = await store.version();
          if (v != null && String(v) === String(query.v)) return [204, null];
        }
        const row = await current();
        const me = identify(row.state, query.code);
        if (!me) return [401, { error: 'Sign in again.' }];
        return [200, frame(row, me)];
      }
      if (route === 'action' && method === 'POST') {
        if (body.type === 'ai-use' || body.type === 'ai-refund') return [400, { error: 'Unknown action.' }];
        const [st, json] = await runAction(headers['x-code'], body);
        return [st, json];
      }
      if (route === 'ai' && method === 'POST') {
        if (!ai) return [503, { error: 'The AI assistant is not switched on.' }];
        const [st, json, S, me] = await runAction(headers['x-code'], { type: 'ai-use', kind: body.kind, id: body.id });
        if (st !== 200) return [st, json];
        const teamId = me.role === 'team' ? me.teamId : body.id;
        const live = body.w && typeof body.w === 'object' ? body.w : {};
        if (Array.isArray(live.whys)) live.whys = live.whys.slice(0, 5).map((x) => String(x ?? '').slice(0, 1200));
        for (const k of ['root', 'title', 'approach', 'impl', 'benefits']) if (live[k] != null) live[k] = String(live[k]).slice(0, 1200);
        try { return [200, { ...json, result: await ai(body.kind, S, teamId, live) }]; }
        catch (e) {
          if (me.role === 'team') await runAction(headers['x-code'], { type: 'ai-refund', kind: body.kind }).catch(() => {});
          if (e instanceof AiError) return [502, { error: e.message }];
          throw e;
        }
      }
      if (route === 'health') return [200, { ok: true, version: await store.version() }];
      return [404, { error: 'Not found' }];
    } catch (e) {
      console.error(e);
      return [500, { error: 'Something went wrong on the server.' }];
    }
  };
}

/** In-memory store backed by a JSON file (local server). */
export function fileStore(fs, file) {
  let row = null;
  try { row = JSON.parse(fs.readFileSync(file, 'utf8')); if (!row.state) row = { state: row, version: 1 }; } catch {}
  const persist = () => {
    fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(row));
    fs.renameSync(file + '.tmp', file);
  };
  return {
    async load() { return row; },
    async init(state) { row = { state, version: 1 }; persist(); return row; },
    async version() { return row?.version ?? null; },
    async cas(state, version) { if (!row || row.version !== version) return null; row = { state, version: version + 1 }; persist(); return row.version; },
  };
}

/** Supabase store: talks to the ric_* SQL functions over PostgREST. */
export function supabaseStore({ url, apiKey, serverKey, eventId = 'main' }) {
  const rpc = async (fn, args) => {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: serverKey, p_id: eventId, ...args }),
    });
    if (!r.ok) throw new Error(`Supabase ${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    load: () => rpc('ric_get', {}),
    init: (state) => rpc('ric_init', { p_state: state }),
    version: () => rpc('ric_version', {}),
    cas: (state, version) => rpc('ric_cas', { p_version: version, p_state: state }),
  };
}
