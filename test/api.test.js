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
  [st, j] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': teamCode }, body: { type: 'submit-new', p: { title: 'Hello' } } });
  assert.equal(st, 200); assert.equal(j.version, v + 1); assert.equal(j.state.auth, undefined);
  [st, j] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': teamCode }, body: { type: 'reveal' } });
  assert.equal(st, 400);
  [st] = await handle({ method: 'POST', route: 'action', headers: { 'x-code': 'nope' }, body: { type: 'reveal' } });
  assert.equal(st, 401);
  // survives a restart
  const again = createApi({ store: fileStore(fs, path.join(dir, 'state.json')), config, env: {} });
  [st, j] = await again({ method: 'GET', route: 'state', query: { code: teamCode } });
  assert.equal(j.state.teams[0].primary.title, 'Hello');
});
