import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createState, apply, identify, redact, act, results, isUserError, remaining } from '../shared/logic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const samples = JSON.parse(fs.readFileSync(new URL('../samples.json', import.meta.url)));
const FAC = { role: 'facilitator' }, PANEL = { role: 'panel' };
const teamMe = (S, i) => ({ role: 'team', teamId: S.teams[i].id });
const ch = (title) => ({ title, cat: 'Other', stage: 'Lending', problem: 'p', affects: 'a', why: 'w' });
const throwsUser = (fn, re) => assert.throws(fn, (e) => isUserError(e) && (!re || re.test(e.message)));

test('codes identify the right device', () => {
  const S = createState(config);
  assert.deepEqual(identify(S, S.auth.facilitator.toLowerCase()), FAC);
  assert.deepEqual(identify(S, S.teams[2].code), teamMe(S, 2));
  assert.deepEqual(identify(S, S.judges[1].code), { role: 'judge', judge: 1 });
  assert.equal(identify(S, 'nope'), null);
});

test('redaction hides codes and other judges\' scores', () => {
  const S = createState(config);
  S.scores = { 0: { x: 1 }, 1: { y: 2 } };
  const forTeam = redact(S, teamMe(S, 0));
  assert.equal(forTeam.auth, undefined);
  assert.ok(forTeam.teams[0].code);
  assert.equal(forTeam.teams[1].code, undefined);
  assert.deepEqual(forTeam.scores, {});
  const forJudge = redact(S, { role: 'judge', judge: 1 });
  assert.deepEqual(Object.keys(forJudge.scores), ['1']);
  assert.ok(redact(S, FAC).auth.facilitator);
});

test('roles and phases are enforced', () => {
  const S = createState(config);
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'approve', id: S.teams[0].id }), /not allowed/);
  throwsUser(() => apply(S, FAC, { type: 'phase', id: 'sprint' }), /Lock/);
  throwsUser(() => apply(S, FAC, { type: 'lock' }), /approved/);
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'canvas', c: {} }), /stage/);
});

test('duplicate moves a team to its backup; full flow to results', () => {
  const S = createState(config);
  const [a, b] = S.teams;
  apply(S, teamMe(S, 0), { type: 'submit-new', p: ch('Account opening takes many visits'), b: ch('Backup A') });
  apply(S, teamMe(S, 1), { type: 'submit-new', p: ch('Account opening takes many visits'), b: ch('Backup B') });
  throwsUser(() => apply(S, teamMe(S, 1), { type: 'submit-new', p: ch('again') }), /already/);
  apply(S, PANEL, { type: 'approve', id: a.id });
  apply(S, PANEL, { type: 'dup', id: b.id, of: a.id });
  assert.equal(b.active, 'backup');
  assert.equal(act(b).title, 'Backup B');
  assert.equal(act(b).status, 'pending');

  throwsUser(() => apply(S, PANEL, { type: 'refine', id: b.id, note: '' }), /comment/);
  apply(S, PANEL, { type: 'refine', id: b.id, note: 'Narrow it' });
  apply(S, teamMe(S, 1), { type: 'resubmit', p: ch('Backup B narrowed') });
  apply(S, PANEL, { type: 'reject', id: b.id, note: 'Out of scope' });
  assert.equal(act(b).status, 'rejected'); // no backup left
  apply(S, teamMe(S, 1), { type: 'again', p: ch('Fresh idea') });
  assert.equal(S.history.length, 1);
  apply(S, PANEL, { type: 'approve', id: b.id });

  S.teams.slice(2).forEach((t, i) => {
    apply(S, teamMe(S, i + 2), { type: 'submit-new', p: ch('Unique challenge number ' + 'xyzwvu'[i]) });
    apply(S, PANEL, { type: 'approve', id: t.id });
  });
  apply(S, FAC, { type: 'lock' });
  apply(S, FAC, { type: 'phase', id: 'sprint' });
  apply(S, FAC, { type: 't-start', id: 'sprint' }, 1000);
  assert.equal(Math.round(remaining(S.sprint, 61000)), 32 * 60 - 60);
  apply(S, teamMe(S, 0), { type: 'canvas', c: { title: 'Pitch', approach: 'x', impl: 'y', benefits: 'z' } });
  apply(S, FAC, { type: 'phase', id: 'pitch' });

  const j0 = { role: 'judge', judge: 0 };
  throwsUser(() => apply(S, j0, { type: 'submit-score', team: a.id }), /every/);
  [5, 5, 5, 5, 5].forEach((v, c) => apply(S, j0, { type: 'score', team: a.id, c, v }));
  apply(S, j0, { type: 'submit-score', team: a.id });
  throwsUser(() => apply(S, j0, { type: 'score', team: a.id, c: 0, v: 1 }), /already/);
  apply(S, FAC, { type: 'phase', id: 'results' });
  const r = results(S);
  assert.equal(r[0].t.id, a.id);
  assert.equal(r[0].avg, 100);
});

test('rehearsal tools fill a complete event', () => {
  const S = createState(config);
  apply(S, FAC, { type: 'demo-s5' }, Date.now(), samples);
  assert.equal(S.teams.filter((t) => act(t).status === 'approved').length, S.teams.length);
  apply(S, FAC, { type: 'lock' });
  apply(S, FAC, { type: 'demo-canvas' }, Date.now(), samples);
  apply(S, FAC, { type: 'phase', id: 'pitch' });
  apply(S, FAC, { type: 'demo-scores' }, Date.now(), samples);
  assert.ok(results(S).every((r) => r.n === S.judges.length - 1));
  apply(S, FAC, { type: 'reset-round' });
  assert.equal(S.phase, 's5');
  assert.ok(S.teams.every((t) => !t.primary));
});
