// Shared game logic for the Retail Innovation Challenge.
// Runs on the server (authoritative reducer) and in the browser (derived views).

export const CATS = ['Customer Engagement', 'Digital Adoption', 'Sales Performance', 'Operational Efficiency', 'Process Improvement', 'Other'];
export const STAGES = ['Awareness & enquiry', 'Onboarding / account opening', 'Everyday servicing', 'Lending', 'Cards & payments', 'Complaints & resolution', 'Other'];
export const CRIT = [
  { k: 'Practicality', w: 25 }, { k: 'Customer impact', w: 25 }, { k: 'Business benefit', w: 20 },
  { k: 'Innovation', w: 15 }, { k: 'Pitch & timing', w: 15 }];
export const PHASES = [
  { id: 's5', label: 'Challenge submissions', sub: 'Session 05 · 09:00–09:30' },
  { id: 'locked', label: 'Challenges locked', sub: 'Before 16:00' },
  { id: 'sprint', label: 'Ideation sprint', sub: 'Session 10 · 16:03–16:35' },
  { id: 'pitch', label: 'Pitches', sub: '16:35–16:55' },
  { id: 'results', label: 'Results', sub: '16:55–17:00' }];
export const statusLabel = {
  pending: 'Awaiting panel', approved: 'Approved', refine: 'Sent back to refine', duplicate: 'Duplicate',
  rejected: 'Not accepted', standby: 'Backup', none: 'Not submitted' };

export const SPRINT_SECONDS = 32 * 60;
export const PITCH_SECONDS = 180;
const MAX = { title: 160, text: 1200, note: 300 };

/* ---------- state ---------- */
const code = (prefix) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return prefix ? `${prefix}-${s}` : s;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';

export function createState(config) {
  const used = new Set();
  const teams = config.teams.map((name) => {
    let id = slug(name.replace(/^team\s+/i, '')); while (used.has(id)) id += 'x'; used.add(id);
    return { id, name, code: code(id.slice(0, 3).toUpperCase()), active: 'primary', primary: null, backup: null };
  });
  return {
    version: 1,
    event: { eyebrow: config.eyebrow || '', title: config.title || 'Retail Innovation Challenge', timeZone: config.timeZone || 'UTC' },
    auth: { facilitator: config.facilitatorCode || code('FAC'), panel: config.panelCode || code('PNL'), projector: config.projectorCode || code('PRJ') },
    judges: config.judges.map((name, i) => ({ name, code: code('J' + (i + 1)) })),
    teams,
    ...freshRound(),
  };
}
function freshRound() {
  return {
    phase: 's5', locked: false, seq: 0, history: [],
    sprint: { dur: SPRINT_SECONDS, acc: 0, start: null },
    pitchT: { dur: PITCH_SECONDS, acc: 0, start: null },
    pitchIdx: 0, reveal: 0, scores: {}, canvases: {},
  };
}

/* ---------- auth & redaction ---------- */
export function identify(S, raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (!c) return null;
  if (c === S.auth.facilitator.toUpperCase()) return { role: 'facilitator' };
  if (c === S.auth.panel.toUpperCase()) return { role: 'panel' };
  if (c === S.auth.projector.toUpperCase()) return { role: 'projector' };
  const j = S.judges.findIndex((x) => x.code.toUpperCase() === c);
  if (j >= 0) return { role: 'judge', judge: j };
  const t = S.teams.find((x) => x.code.toUpperCase() === c);
  if (t) return { role: 'team', teamId: t.id };
  return null;
}

/** The copy of state a given device is allowed to see. */
export function redact(S, me) {
  const out = structuredClone(S);
  if (me.role !== 'facilitator') {
    delete out.auth;
    out.teams.forEach((t) => { if (!(me.role === 'team' && me.teamId === t.id)) delete t.code; });
    out.judges.forEach((j, i) => { if (!(me.role === 'judge' && me.judge === i)) delete j.code; });
  }
  if (me.role === 'judge') out.scores = { [me.judge]: out.scores[me.judge] || {} };
  else if (me.role === 'team' || me.role === 'panel') out.scores = {};
  if (me.role === 'team') {
    for (const k of Object.keys(out.canvases)) if (k !== me.teamId && !['pitch', 'results'].includes(S.phase)) delete out.canvases[k];
  }
  return out;
}

/* ---------- derived helpers ---------- */
export const team = (S, id) => S.teams.find((t) => t.id === id);
export const act = (t) => t && t[t.active];
export function teamState(t) {
  const a = act(t);
  if (!t.primary || !a) return 'new';
  if (a.status === 'refine') return 'refine';
  if (a.status === 'duplicate' || a.status === 'rejected') return 'again';
  return 'ok';
}
export const curStatus = (t) => (teamState(t) === 'new' ? 'none' : act(t).status);

const STOP = new Set(['customers', 'customer', 'takes', 'with', 'that', 'from', 'their', 'into', 'need', 'needs', 'more', 'than', 'have', 'dont', 'don', 'they', 'where', 'what', 'when', 'this', 'can', 'cant', 'easily', 'many', 'means', 'must', 'never', 'could']);
const words = (s) => new Set(((s || '').toLowerCase().replace(/'/g, '').match(/[a-z]+/g) || []).filter((w) => w.length > 3 && !STOP.has(w)));

/** Earlier (or approved) challenge from another team that looks like this team's active one. */
export function similarTo(S, t) {
  const a = act(t); if (!a) return null;
  const w = words(a.title); let best = null;
  for (const o of S.teams) {
    if (o === t) continue;
    const b = act(o);
    if (!b || ['duplicate', 'rejected'].includes(b.status)) continue;
    if (!(b.status === 'approved' || (b.seq || 0) < (a.seq || 0))) continue;
    const w2 = words(b.title);
    const inter = [...w].filter((x) => w2.has(x)).length;
    const uni = new Set([...w, ...w2]).size;
    const j = uni ? inter / uni : 0;
    if (j >= 0.34 && (!best || j > best.j)) best = { team: o, j };
  }
  return best;
}
export const approvedCount = (S) => S.teams.filter((t) => act(t)?.status === 'approved').length;
export const allApproved = (S) => approvedCount(S) === S.teams.length;
export const phaseIdx = (S) => PHASES.findIndex((p) => p.id === S.phase);

export const elapsed = (x, now) => x.acc + (x.start ? (now - x.start) / 1000 : 0);
export const remaining = (x, now) => Math.max(0, x.dur - elapsed(x, now));
export const fmt = (s) => { s = Math.ceil(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export const emptyCanvas = () => ({ title: '', approach: '', impl: '', benefits: '', saved: '' });
export const canvasOf = (S, id) => S.canvases[id] || emptyCanvas();
export const judgeTotal = (c) => c.reduce((s, v, i) => s + (v || 0) * CRIT[i].w, 0) / 5;

export function results(S) {
  return S.teams.map((t) => {
    const subs = S.judges.map((_, j) => S.scores[j]?.[t.id]).filter((x) => x && x.submitted);
    const avg = subs.length ? subs.reduce((s, x) => s + judgeTotal(x.c), 0) / subs.length : 0;
    const critAvg = CRIT.map((_, i) => (subs.length ? subs.reduce((s, x) => s + x.c[i], 0) / subs.length : 0));
    return { t, avg, n: subs.length, critAvg };
  }).sort((a, b) => b.avg - a.avg);
}

export function clock(S, now) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: S.event.timeZone }).format(new Date(now));
  } catch { const d = new Date(now); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
}

/* ---------- reducer ---------- */
class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };
export const isUserError = (e) => e instanceof UserError;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
function cleanChallenge(p) {
  p = p || {};
  const c = {
    title: str(p.title, MAX.title), cat: CATS.includes(p.cat) ? p.cat : CATS[0], stage: STAGES.includes(p.stage) ? p.stage : STAGES[0],
    problem: str(p.problem, MAX.text), affects: str(p.affects, MAX.title), why: str(p.why, MAX.text),
  };
  return c;
}
function promote(S, t, now) {
  if (t.active === 'primary' && t.backup && t.backup.status === 'standby') {
    t.active = 'backup'; Object.assign(t.backup, { status: 'pending', ts: clock(S, now), seq: ++S.seq });
    return true;
  }
  return false;
}
const need = (me, ...roles) => { if (!roles.includes(me.role)) fail('Your device is not allowed to do that.'); };
const needPhase = (S, ...ps) => { if (!ps.includes(S.phase)) fail('That is not available at this stage of the session.'); };
const timerKey = (id) => (id === 'sprint' || id === 'pitchT' ? id : fail('Unknown timer.'));

/**
 * Applies an action to state in place. Validates before mutating.
 * Returns { toast? }. Throws UserError for invalid actions.
 */
export function apply(S, me, a, now = Date.now(), samples = null) {
  const T = (id) => team(S, id) || fail('Unknown team.');
  switch (a.type) {
    /* ----- facilitator ----- */
    case 'phase': {
      need(me, 'facilitator');
      if (!PHASES.some((p) => p.id === a.id)) fail('Unknown stage.');
      if (a.id === 'locked' && !allApproved(S)) fail(`All ${S.teams.length} teams need an approved challenge first.`);
      if (!['s5', 'locked'].includes(a.id) && !S.locked) fail('Lock the challenges first.');
      if (a.id === 'locked') S.locked = true;
      if (a.id === 's5') S.locked = false;
      S.phase = a.id;
      if (a.id === 'results') S.reveal = 0;
      return {};
    }
    case 'lock':
      need(me, 'facilitator'); needPhase(S, 's5');
      if (!allApproved(S)) fail(`All ${S.teams.length} teams need an approved challenge first.`);
      S.locked = true; S.phase = 'locked';
      return { toast: 'Challenges locked and published to the projector.' };
    case 't-start': {
      need(me, 'facilitator'); const k = timerKey(a.id); const x = S[k];
      if (x.start) return {};
      if (remaining(x, now) === 0) x.acc = 0;
      x.start = now; return {};
    }
    case 't-pause': {
      need(me, 'facilitator'); const x = S[timerKey(a.id)];
      if (x.start) { x.acc = Math.min(x.dur, elapsed(x, now)); x.start = null; }
      return {};
    }
    case 't-reset': { need(me, 'facilitator'); const x = S[timerKey(a.id)]; x.acc = 0; x.start = null; return {}; }
    case 'next-team':
      need(me, 'facilitator'); needPhase(S, 'pitch');
      if (S.pitchIdx < S.teams.length - 1) { S.pitchIdx++; S.pitchT = { dur: PITCH_SECONDS, acc: 0, start: null }; }
      return {};
    case 'prev-team':
      need(me, 'facilitator'); needPhase(S, 'pitch');
      if (S.pitchIdx > 0) { S.pitchIdx--; S.pitchT = { dur: PITCH_SECONDS, acc: 0, start: null }; }
      return {};
    case 'reveal': need(me, 'facilitator'); needPhase(S, 'results'); S.reveal = Math.min(S.teams.length, S.reveal + 1); return {};
    case 'reveal-reset': need(me, 'facilitator'); S.reveal = 0; return {};
    case 'reset-round': {
      need(me, 'facilitator');
      Object.assign(S, freshRound());
      S.teams.forEach((t) => { t.primary = null; t.backup = null; t.active = 'primary'; });
      return { toast: 'Event reset. All submissions, canvases and scores were cleared.' };
    }

    /* ----- panel ----- */
    case 'approve': case 'undo': case 'dup': case 'refine': case 'reject': {
      need(me, 'panel'); needPhase(S, 's5');
      const t = T(a.id); const c = act(t);
      if (!c) fail('That team has not submitted yet.');
      if (a.type === 'undo') { if (c.status !== 'approved') fail('Only an approved challenge can be undone.'); c.status = 'pending'; return {}; }
      if (c.status !== 'pending') fail('This challenge is no longer waiting for review.');
      if (a.type === 'approve') { c.status = 'approved'; c.note = ''; return { toast: t.name + ' approved.' }; }
      if (a.type === 'dup') {
        const of = T(a.of); if (of === t) fail('Pick another team.');
        c.status = 'duplicate'; c.note = `Same as ${of.name}'s challenge.`;
        return { toast: promote(S, t, now) ? t.name + ' moved to its backup challenge.' : t.name + ' asked for a new challenge.' };
      }
      const note = str(a.note, MAX.note);
      if (!note) fail(a.type === 'refine' ? 'Add a comment so the team knows what to change.' : 'Add a reason for the team.');
      c.note = note;
      if (a.type === 'refine') { c.status = 'refine'; return { toast: 'Sent back to ' + t.name + '.' }; }
      c.status = 'rejected';
      return { toast: promote(S, t, now) ? t.name + ' moved to its backup challenge.' : t.name + ' asked for a new challenge.' };
    }

    /* ----- team ----- */
    case 'submit-new': case 'resubmit': case 'again': {
      need(me, 'team'); needPhase(S, 's5');
      const t = T(me.teamId); const p = cleanChallenge(a.p);
      if (!p.title) fail('Add a challenge title.');
      const st = teamState(t); const ts = clock(S, now);
      if (a.type === 'submit-new') {
        if (st !== 'new') fail('Your team has already submitted.');
        const b = cleanChallenge(a.b);
        t.primary = { ...p, status: 'pending', ts, note: '', seq: ++S.seq };
        t.backup = b.title ? { ...b, status: 'standby', ts, note: '' } : null;
        t.active = 'primary';
      } else if (a.type === 'resubmit') {
        if (st !== 'refine') fail('Nothing to resubmit.');
        Object.assign(act(t), p, { status: 'pending', note: '', ts, seq: ++S.seq });
        return { toast: 'Resubmitted.' };
      } else {
        if (st !== 'again') fail('Nothing to replace.');
        S.history.push({ team: t.name, c: act(t) });
        t.backup = { ...p, status: 'pending', ts, note: '', seq: ++S.seq }; t.active = 'backup';
      }
      return { toast: 'Submitted to the panel.' };
    }
    case 'canvas': {
      need(me, 'team'); needPhase(S, 'sprint');
      const v = a.c || {};
      S.canvases[me.teamId] = {
        title: str(v.title, MAX.title), approach: str(v.approach, MAX.text), impl: str(v.impl, MAX.text),
        benefits: str(v.benefits, MAX.text), saved: clock(S, now) };
      return { toast: 'Canvas saved.' };
    }

    /* ----- judge ----- */
    case 'score': case 'submit-score': {
      need(me, 'judge'); needPhase(S, 'pitch', 'results');
      T(a.team);
      const mine = S.scores[me.judge] || (S.scores[me.judge] = {});
      const s = mine[a.team] || (mine[a.team] = { c: [0, 0, 0, 0, 0], submitted: false });
      if (s.submitted) fail('This score is already submitted.');
      if (a.type === 'score') {
        const ci = Number(a.c), v = Number(a.v);
        if (!(ci >= 0 && ci < CRIT.length && Number.isInteger(ci)) || ![1, 2, 3, 4, 5].includes(v)) fail('Invalid score.');
        s.c[ci] = v; return {};
      }
      if (!s.c.every((x) => x > 0)) fail('Score every criterion first.');
      s.submitted = true; return { toast: 'Score submitted and locked.' };
    }

    /* ----- rehearsal shortcuts (facilitator) ----- */
    case 'demo-s5': {
      need(me, 'facilitator'); needPhase(S, 's5'); if (!samples) fail('Sample data is not available.');
      const ts = clock(S, now);
      S.teams.forEach((t, i) => {
        if (t.primary) return;
        const smp = samples.challenges[i % samples.challenges.length];
        t.primary = { ...cleanChallenge(smp.primary), status: 'pending', ts, note: '', seq: ++S.seq };
        t.backup = { ...cleanChallenge(smp.backup), status: 'standby', ts, note: '' };
        t.active = 'primary';
      });
      let dups = [];
      for (const t of S.teams) {
        const c = act(t);
        if (c && c.status === 'pending') { const sim = similarTo(S, t); if (sim) { c.status = 'duplicate'; c.note = `Same as ${sim.team.name}'s challenge.`; promote(S, t, now); dups.push(t.name); } }
      }
      for (const t of S.teams) { const c = act(t); if (c && ['pending', 'refine'].includes(c.status)) c.status = 'approved'; }
      return { toast: 'Sample submissions added and approved.' + (dups.length ? ` ${dups.join(', ')} moved to backup as duplicate.` : '') };
    }
    case 'demo-canvas':
      need(me, 'facilitator'); if (!samples) fail('Sample data is not available.');
      S.teams.forEach((t, i) => { S.canvases[t.id] = { ...samples.canvases[i % samples.canvases.length], saved: clock(S, now) }; });
      return { toast: 'Sample canvases filled.' };
    case 'demo-scores': {
      need(me, 'facilitator'); if (!samples) fail('Sample data is not available.');
      const n = Math.max(1, S.judges.length - 1);
      for (let j = 0; j < n; j++) {
        S.scores[j] = S.scores[j] || {};
        S.teams.forEach((t, i) => { S.scores[j][t.id] = { c: samples.scores[(i + j * 3) % samples.scores.length].slice(), submitted: true }; });
      }
      return { toast: `Sample scores added for ${n} judge${n > 1 ? 's' : ''}.` };
    }
    default: fail('Unknown action.');
  }
}
