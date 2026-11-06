import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createState, apply, identify, redact, isUserError, remaining, timeUp, ROOT_SECONDS, SOLUTION_SECONDS } from '../shared/logic.js';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const samples = JSON.parse(fs.readFileSync(new URL('../samples.json', import.meta.url)));
const FAC = { role: 'facilitator' }, P0 = { role: 'panelist', p: 0 }, P1 = { role: 'panelist', p: 1 };
const teamMe = (S, i) => ({ role: 'team', teamId: S.teams[i].id });
const ch = (title) => ({ title, cat: 'Customer pain point', problem: 'p', affects: 'a', why: 'w' });
const throwsUser = (fn, re) => assert.throws(fn, (e) => isUserError(e) && (!re || re.test(e.message)));
function approveAll(S) {
  S.teams.forEach((t, i) => { apply(S, teamMe(S, i), { type: 'submit', p: ch('Challenge ' + i) }); apply(S, i % 2 ? P1 : P0, { type: 'approve', id: t.id }); });
}

test('six teams and two panelists, each with a code', () => {
  const S = createState(config);
  assert.equal(S.teams.length, 6); assert.equal(S.panelists.length, 2);
  assert.deepEqual(identify(S, S.auth.facilitator.toLowerCase()), FAC);
  assert.deepEqual(identify(S, S.teams[2].code), teamMe(S, 2));
  assert.deepEqual(identify(S, S.panelists[1].code), P1);
  assert.equal(identify(S, 'nope'), null);
});

test('redaction hides codes and other teams\' work', () => {
  const S = createState(config);
  S.work = { [S.teams[1].id]: { root: 'secret' } }; S.phase = 'root';
  const forTeam = redact(S, teamMe(S, 0));
  assert.equal(forTeam.auth, undefined);
  assert.ok(forTeam.teams[0].code); assert.equal(forTeam.teams[1].code, undefined);
  assert.deepEqual(forTeam.work, {});
  assert.equal(redact(S, { role: 'projector' }).work[S.teams[1].id].root, '');
  assert.equal(redact(S, { role: 'projector' }).work[S.teams[1].id].hasRoot, true);
  assert.ok(redact(S, FAC).auth.facilitator);
});

test('one challenge per team; either panelist approves; all approved locks', () => {
  const S = createState(config);
  const [a] = S.teams;
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'approve', id: a.id }), /not allowed/);
  throwsUser(() => apply(S, FAC, { type: 'phase', id: 'root' }), /locked/);
  apply(S, teamMe(S, 0), { type: 'submit', p: ch('Queues are long') });
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'submit', p: ch('Another') }), /only one/);
  throwsUser(() => apply(S, P0, { type: 'refine', id: a.id, note: '' }), /comment/);
  apply(S, P0, { type: 'refine', id: a.id, note: 'Too broad' });
  assert.equal(a.ch.status, 'refine');
  apply(S, teamMe(S, 0), { type: 'resubmit', p: ch('Queues for statements are long') });
  apply(S, P1, { type: 'approve', id: a.id });
  assert.equal(a.ch.by, 'Panelist 2');
  throwsUser(() => apply(S, P0, { type: 'approve', id: a.id }), /Already approved by Panelist 2/);
  assert.equal(S.phase, 'submit');
  S.teams.slice(1).forEach((t, i) => { apply(S, teamMe(S, i + 1), { type: 'submit', p: ch('C' + i) }); apply(S, P0, { type: 'approve', id: t.id }); });
  assert.equal(S.phase, 'locked'); assert.equal(S.locked, true);
  throwsUser(() => apply(S, P0, { type: 'undo', id: a.id }), /stage/);
});

test('root cause and solution saves stop when time is up', () => {
  const S = createState(config); approveAll(S);
  apply(S, FAC, { type: 'phase', id: 'root' });
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'save-solution', w: {} }), /stage/);
  apply(S, FAC, { type: 't-start', id: 'rootT' }, 0);
  apply(S, teamMe(S, 0), { type: 'save-root', w: { whys: ['a', 'b'], root: 'r' } }, 60_000);
  assert.equal(S.work[S.teams[0].id].root, 'r');
  assert.equal(S.work[S.teams[0].id].whys.length, 5);
  assert.equal(Math.round(remaining(S.rootT, 60_000)), ROOT_SECONDS - 60);
  apply(S, teamMe(S, 0), { type: 'save-root', w: { root: 'r2' } }, ROOT_SECONDS * 1000 + 5_000); // within grace
  throwsUser(() => apply(S, teamMe(S, 0), { type: 'save-root', w: { root: 'late' } }, ROOT_SECONDS * 1000 + 30_000), /Time is up/);
  assert.equal(S.work[S.teams[0].id].root, 'r2');
  // +1 min after time ran out gives a full minute from now
  const t = ROOT_SECONDS * 1000 + 30_000;
  apply(S, FAC, { type: 't-add', id: 'rootT' }, t);
  assert.equal(Math.round(remaining(S.rootT, t)), 60);
  assert.equal(timeUp(S.rootT, t), false);
  apply(S, FAC, { type: 'phase', id: 'solution' });
  assert.equal(S.solT.dur, SOLUTION_SECONDS);
  apply(S, teamMe(S, 0), { type: 'save-solution', w: { title: 'Fast lane', approach: 'x', impl: 'y', benefits: 'z' } });
  assert.equal(S.work[S.teams[0].id].root, 'r2'); // root cause kept
});

test('pitches are the last stage; teams see every pitch', () => {
  const S = createState(config); approveAll(S);
  throwsUser(() => apply(S, FAC, { type: 'phase', id: 'results' }), /Unknown stage/);
  apply(S, FAC, { type: 'phase', id: 'root' });
  apply(S, teamMe(S, 1), { type: 'save-root', w: { root: 'r1' } });
  apply(S, FAC, { type: 'phase', id: 'pitch' });
  assert.equal(redact(S, teamMe(S, 0)).work[S.teams[1].id].root, 'r1');
  throwsUser(() => apply(S, P0, { type: 'score', team: S.teams[0].id, c: 0, v: 5 }), /Unknown action/);
  for (let i = 0; i < 10; i++) apply(S, FAC, { type: 'next-team' });
  assert.equal(S.pitchIdx, S.teams.length - 1);
});

test('rehearsal tools fill a complete event', () => {
  const S = createState(config);
  apply(S, FAC, { type: 'demo-submit' }, Date.now(), samples);
  apply(S, FAC, { type: 'demo-approve' }, Date.now(), samples);
  assert.equal(S.phase, 'locked');
  apply(S, FAC, { type: 'demo-root' }, Date.now(), samples);
  apply(S, FAC, { type: 'demo-solution' }, Date.now(), samples);
  assert.ok(S.teams.every((t) => S.work[t.id].root && S.work[t.id].title));
  apply(S, FAC, { type: 'phase', id: 'pitch' });
  apply(S, FAC, { type: 'reset-round' });
  assert.equal(S.phase, 'submit');
  assert.ok(S.teams.every((t) => !t.ch));
});
