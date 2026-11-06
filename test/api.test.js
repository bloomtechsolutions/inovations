import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi, fileStore } from '../shared/api.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));

test('api: login, polling with version, actions, env codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ric-'));
  const store = fileStore(fs, path.join(dir, 'state.json'));
  const handle = createApi({ store, config, samples: null, env: { FACILITATOR_CODE: 'FAC-TEST' } });
  let [st, j] = await handle({ method: 'POST', route: 'login', body: { code: 'fac-test' } });
  assert.equal(st, 200); assert.equal(j.me.role, 'facilitator');
  [st, j] = await handle({ method: 'GET', route: 'state', query: { code: 'FAC-TEST' } });
  assert.equal(st, 200);
  const v = j.version; const teamCode = j.state.teams[0].code;
  [st] = await handle({ method: 'GET', route: 'state', query: { code: 'FAC-TEST', v: String(v) } });
  assert.equal(st, 204);
  [st, j] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': teamCode }, body: { type: 'submit', p: { title: 'Hello', problem: 'World' } } });
  assert.equal(st, 200); assert.equal(j.version, v + 1); assert.equal(j.state.auth, undefined);
  [st, j] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': teamCode }, body: { type: 'reveal' } });
  assert.equal(st, 400);
  [st] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': 'nope' }, body: { type: 'reveal' } });
  assert.equal(st, 401);
  // survives a restart
  const again = createApi({ store: fileStore(fs, path.join(dir, 'state.json')), config, env: {} });
  [st, j] = await again({ method: 'GET', route: 'state', query: { code: teamCode } });
  assert.equal(j.state.teams[0].ch.title, 'Hello');
});

test('api: AI route checks the device, counts use and refunds failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ric-'));
  const calls = [];
  let fail = false;
  const ai = async (kind, S, teamId, live) => {
    calls.push({ kind, teamId, live });
    if (fail) { const { AiError } = await import('../shared/ai.js'); throw new AiError('busy'); }
    return { hints: ['Why do customers forget documents?'] };
  };
  const handle = createApi({ store: fileStore(fs, path.join(dir, 'state.json')), config, samples: JSON.parse(fs.readFileSync(new URL('../samples.json', import.meta.url))), env: { FACILITATOR_CODE: 'FAC-TEST' }, ai });
  const post = (route, code, body) => handle({ method: 'POST', route, headers: { 'x-code': code }, body });
  let [st, j] = await handle({ method: 'GET', route: 'state', query: { code: 'FAC-TEST' } });
  assert.equal(j.ai, true);
  const team = j.state.teams[0].code;
  await post('action', 'FAC-TEST', { type: 'demo-submit' }); await post('action', 'FAC-TEST', { type: 'demo-approve' });
  [st, j] = await post('ai', team, { kind: 'hint', w: { whys: ['a'] } });
  assert.equal(st, 400); // not the root cause stage yet
  await post('action', 'FAC-TEST', { type: 'phase', id: 'root' });
  [st, j] = await post('ai', team, { kind: 'hint', w: { whys: ['a'], root: 'r' } });
  assert.equal(st, 200); assert.deepEqual(j.result.hints, ['Why do customers forget documents?']);
  assert.equal(j.state.ai[j.me.teamId].hint, 1); assert.equal(calls[0].live.root, 'r');
  fail = true;
  [st, j] = await post('ai', team, { kind: 'hint' });
  assert.equal(st, 502);
  [st, j] = await handle({ method: 'GET', route: 'state', query: { code: team } });
  assert.equal(j.state.ai[j.me.teamId].hint, 1); // refunded
  [st] = await post('action', team, { type: 'ai-use', kind: 'hint' });
  assert.equal(st, 400); // cannot be called directly
  const off = createApi({ store: fileStore(fs, path.join(dir, 'state.json')), config, env: { FACILITATOR_CODE: 'FAC-TEST' } });
  [st] = await off({ method: 'POST', route: 'ai', headers: { 'x-code': team }, body: { kind: 'hint' } });
  assert.equal(st, 503);
});
