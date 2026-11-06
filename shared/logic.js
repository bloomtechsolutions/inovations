// Shared rules for the Innovation Challenge.
// Runs on the server (the only source of truth) and in the browser (derived views).

export const CATS = ['Internal process', 'Customer pain point', 'New way to serve customers'];
export const PHASES = [
  { id: 'submit', label: 'Challenges', sub: 'Stage 1 · submit & approve' },
  { id: 'locked', label: 'Locked', sub: 'All challenges confirmed' },
  { id: 'root', label: 'Root cause', sub: 'Stage 2 · 5 min' },
  { id: 'solution', label: 'Solution', sub: 'Stage 2 · 20 min' },
  { id: 'pitch', label: 'Pitches', sub: 'Teams on stage' }];
export const statusLabel = { pending: 'Awaiting panel', approved: 'Approved', refine: 'Sent back', none: 'Not submitted' };

export const ROOT_SECONDS = 5 * 60;
export const SOLUTION_SECONDS = 20 * 60;
export const PITCH_SECONDS = 5 * 60;
/** Seconds after a timer hits zero during which an in-flight save is still accepted. */
export const GRACE_SECONDS = 15;
export const WHYS = 5;
const MAX = { title: 160, text: 1200, note: 300 };

/* ---------- state ---------- */
const code = (prefix) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return prefix ? `${prefix}-${s}` : s;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
const timer = (dur) => ({ dur, acc: 0, start: null });

export function createState(config) {
  const used = new Set();
  const teams = config.teams.map((name) => {
    let id = slug(name.replace(/^team\s+/i, '')); while (used.has(id)) id += 'x'; used.add(id);
    return { id, name, code: code(id.slice(0, 3).toUpperCase()), ch: null };
  });
  return {
    version: 1,
    event: {
      org: config.org || '', eyebrow: config.eyebrow || '', title: config.title || 'Innovation Challenge',
      timeZone: config.timeZone || 'UTC' },
    auth: { facilitator: config.facilitatorCode || code('FAC'), projector: config.projectorCode || code('PRJ') },
    panelists: (config.panelists || ['Panelist 1', 'Panelist 2']).map((name, i) => ({ name, code: code('P' + (i + 1)) })),
    teams,
    ...freshRound(),
  };
}
function freshRound() {
  return {
    phase: 'submit', locked: false,
    rootT: timer(ROOT_SECONDS), solT: timer(SOLUTION_SECONDS), pitchT: timer(PITCH_SECONDS),
    pitchIdx: 0, work: {},
  };
}

/* ---------- auth & redaction ---------- */
export function identify(S, raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (!c) return null;
  if (c === S.auth.facilitator.toUpperCase()) return { role: 'facilitator' };
  if (c === S.auth.projector.toUpperCase()) return { role: 'projector' };
  const p = S.panelists.findIndex((x) => x.code.toUpperCase() === c);
  if (p >= 0) return { role: 'panelist', p };
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
    out.panelists.forEach((x, i) => { if (!(me.role === 'panelist' && me.p === i)) delete x.code; });
  }
  if (me.role === 'team' && S.phase !== 'pitch') {
    for (const k of Object.keys(out.work)) if (k !== me.teamId) delete out.work[k];
  }
  if (me.role === 'projector' && ['root', 'solution'].includes(S.phase)) {
    // The big screen only shows progress while teams work.
    for (const [k, w] of Object.entries(out.work)) out.work[k] = { ...emptyWork(), hasRoot: !!w.root, hasSolution: !!(w.title && w.approach) };
  }
  return out;
}

/* ---------- derived helpers ---------- */
export const team = (S, id) => S.teams.find((t) => t.id === id);
export const curStatus = (t) => t.ch?.status || 'none';
export const approvedCount = (S) => S.teams.filter((t) => t.ch?.status === 'approved').length;
export const allApproved = (S) => approvedCount(S) === S.teams.length;
export const phaseIdx = (S) => PHASES.findIndex((p) => p.id === S.phase);

export const elapsed = (x, now) => x.acc + (x.start != null ? (now - x.start) / 1000 : 0);
export const remaining = (x, now) => Math.max(0, x.dur - elapsed(x, now));
export const fmt = (s) => { s = Math.ceil(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const TIMER_OF = { root: 'rootT', solution: 'solT', pitch: 'pitchT' };
/** True once a started timer has run past zero (plus the grace period). */
export const timeUp = (x, now, grace = 0) => (x.start != null || x.acc > 0) && elapsed(x, now) > x.dur + grace;

export const emptyWork = () => ({ whys: Array(WHYS).fill(''), root: '', title: '', approach: '', impl: '', benefits: '', savedRoot: '', savedSol: '' });
export const workOf = (S, id) => ({ ...emptyWork(), ...(S.work[id] || {}) });

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
  return {
    title: str(p.title, MAX.title), cat: CATS.includes(p.cat) ? p.cat : CATS[0],
    problem: str(p.problem, MAX.text), affects: str(p.affects, MAX.title), why: str(p.why, MAX.text),
  };
}
const need = (me, ...roles) => { if (!roles.includes(me.role)) fail('Your device is not allowed to do that.'); };
const needPhase = (S, ...ps) => { if (!ps.includes(S.phase)) fail('That is not available at this stage of the event.'); };
const timerKey = (id) => (Object.values(TIMER_OF).includes(id) ? id : fail('Unknown timer.'));
function lockIfDone(S) {
  if (S.phase === 'submit' && allApproved(S)) { S.locked = true; S.phase = 'locked'; return true; }
  return false;
}

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
      if (!['submit', 'locked'].includes(a.id) && !S.locked) fail('All challenges must be approved and locked first.');
      if (a.id === 'locked') S.locked = true;
      if (a.id === 'submit') S.locked = false;
      S.phase = a.id;
      return {};
    }
    case 't-start': {
      need(me, 'facilitator'); const x = S[timerKey(a.id)];
      if (x.start != null) return {};
      if (remaining(x, now) === 0) x.acc = 0;
      x.start = now; return {};
    }
    case 't-pause': {
      need(me, 'facilitator'); const x = S[timerKey(a.id)];
      if (x.start != null) { x.acc = Math.min(x.dur, elapsed(x, now)); x.start = null; }
      return {};
    }
    case 't-add': {
      need(me, 'facilitator'); const x = S[timerKey(a.id)];
      // Fold elapsed time into acc (capped at the end), so a timer that already ran out gets a full minute from now.
      if (x.start != null) { x.acc = Math.min(x.dur, elapsed(x, now)); x.start = now; }
      x.dur += 60; return {};
    }
    case 't-reset': {
      need(me, 'facilitator'); const k = timerKey(a.id);
      S[k] = timer({ rootT: ROOT_SECONDS, solT: SOLUTION_SECONDS, pitchT: PITCH_SECONDS }[k]); return {};
    }
    case 'next-team':
      need(me, 'facilitator'); needPhase(S, 'pitch');
      if (S.pitchIdx < S.teams.length - 1) { S.pitchIdx++; S.pitchT = timer(PITCH_SECONDS); }
      return {};
    case 'prev-team':
      need(me, 'facilitator'); needPhase(S, 'pitch');
      if (S.pitchIdx > 0) { S.pitchIdx--; S.pitchT = timer(PITCH_SECONDS); }
      return {};
    case 'rename': {
      need(me, 'facilitator'); const t = T(a.id); const name = str(a.name, 40);
      if (!name) fail('Add a team name.');
      t.name = name; return { toast: 'Team renamed.' };
    }
    case 'reset-round': {
      need(me, 'facilitator');
      Object.assign(S, freshRound());
      S.teams.forEach((t) => { t.ch = null; });
      return { toast: 'Event reset. All challenges and team work were cleared.' };
    }

    /* ----- panelists ----- */
    case 'approve': case 'undo': case 'refine': {
      need(me, 'panelist'); needPhase(S, 'submit');
      const t = T(a.id); const c = t.ch;
      if (!c) fail('That team has not submitted yet.');
      const by = S.panelists[me.p].name;
      if (a.type === 'undo') { if (c.status !== 'approved') fail('Only an approved challenge can be undone.'); c.status = 'pending'; c.by = ''; return {}; }
      if (c.status !== 'pending') fail(c.status === 'approved' ? `Already approved by ${c.by || 'the other panelist'}.` : 'This challenge is waiting for the team.');
      if (a.type === 'approve') {
        Object.assign(c, { status: 'approved', note: '', by });
        return { toast: lockIfDone(S) ? `${t.name} approved. All challenges are now locked.` : t.name + ' approved.' };
      }
      const note = str(a.note, MAX.note);
      if (!note) fail('Add a comment so the team knows what to change.');
      Object.assign(c, { status: 'refine', note, by });
      return { toast: 'Sent back to ' + t.name + '.' };
    }

    /* ----- team ----- */
    case 'submit': case 'resubmit': {
      need(me, 'team'); needPhase(S, 'submit');
      const t = T(me.teamId); const p = cleanChallenge(a.p);
      if (!p.title) fail('Add a challenge title.');
      if (!p.problem) fail('Describe what happens today.');
      if (a.type === 'submit' && t.ch) fail('Your team has already entered its challenge. Each team can enter only one.');
      if (a.type === 'resubmit' && t.ch?.status !== 'refine') fail('Nothing to resubmit.');
      t.ch = { ...p, status: 'pending', note: '', by: '', ts: clock(S, now) };
      return { toast: a.type === 'submit' ? 'Challenge entered. Come up and explain it to the panel.' : 'Resubmitted to the panel.' };
    }
    case 'save-root': case 'save-solution': {
      need(me, 'team');
      const isRoot = a.type === 'save-root';
      needPhase(S, isRoot ? 'root' : 'solution');
      if (timeUp(S[isRoot ? 'rootT' : 'solT'], now, GRACE_SECONDS)) fail('Time is up. Your last save has been kept.');
      const w = workOf(S, me.teamId); const v = a.w || {};
      if (isRoot) {
        w.whys = Array.from({ length: WHYS }, (_, i) => str(v.whys?.[i], MAX.text));
        w.root = str(v.root, MAX.text); w.savedRoot = clock(S, now);
      } else {
        w.title = str(v.title, MAX.title); w.approach = str(v.approach, MAX.text);
        w.impl = str(v.impl, MAX.text); w.benefits = str(v.benefits, MAX.text); w.savedSol = clock(S, now);
      }
      S.work[me.teamId] = w;
      return a.quiet ? {} : { toast: 'Saved.' };
    }

    /* ----- rehearsal shortcuts (facilitator) ----- */
    case 'demo-submit': {
      need(me, 'facilitator'); needPhase(S, 'submit'); if (!samples) fail('Sample data is not available.');
      const ts = clock(S, now);
      S.teams.forEach((t, i) => {
        if (!t.ch) t.ch = { ...cleanChallenge(samples.challenges[i % samples.challenges.length]), status: 'pending', note: '', by: '', ts };
      });
      return { toast: 'Sample challenges entered. Approve them from a panelist device.' };
    }
    case 'demo-approve': {
      need(me, 'facilitator'); needPhase(S, 'submit');
      S.teams.forEach((t) => { if (t.ch) Object.assign(t.ch, { status: 'approved', note: '', by: S.panelists[0].name }); });
      return { toast: lockIfDone(S) ? 'All approved and locked.' : 'Submitted challenges approved.' };
    }
    case 'demo-root': case 'demo-solution': {
      need(me, 'facilitator'); if (!samples) fail('Sample data is not available.');
      S.teams.forEach((t, i) => {
        const smp = samples.work[i % samples.work.length]; const w = workOf(S, t.id);
        if (a.type === 'demo-root') Object.assign(w, { whys: smp.whys.slice(), root: smp.root, savedRoot: clock(S, now) });
        else Object.assign(w, { title: smp.title, approach: smp.approach, impl: smp.impl, benefits: smp.benefits, savedSol: clock(S, now) });
        S.work[t.id] = w;
      });
      return { toast: a.type === 'demo-root' ? 'Sample root causes filled.' : 'Sample solutions filled.' };
    }
    default: fail('Unknown action.');
  }
}
