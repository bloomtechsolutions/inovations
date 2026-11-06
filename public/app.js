import {
  CATS, PHASES, WHYS, statusLabel, team, curStatus, approvedCount, allApproved, phaseIdx,
  remaining, fmt, timeUp, TIMER_OF, workOf,
} from '/shared/logic.js';

/* ---------- client state ---------- */
let S = null;            // server state (redacted for this device)
let ME = null;           // { role, teamId?, p? }
let CODE = null;         // sign-in code for this device
let OFFSET = 0;          // server clock - local clock
let SAMPLES = false;     // rehearsal tools enabled on server
let VIEW = 'control';    // facilitator tab
const drafts = {};       // unsaved form input, keyed by element id — survives live re-renders

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + OFFSET;
const N = () => S.teams.length;
const pill = (st) => `<span class="pill p-${st}">${statusLabel[st]}</span>`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2800);
}

/* ---------- server I/O ---------- */
function accept(d) {
  if (!d || !d.state || (d.version != null && VERSION != null && d.version < VERSION)) return;
  S = d.state; ME = d.me; SAMPLES = d.samples; OFFSET = d.now - Date.now(); VERSION = d.version;
  render();
}

async function send(a, { quiet = false } = {}) {
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-code': CODE }, body: JSON.stringify(a) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut(); toast(j.error || 'Sign in again.'); return false; }
    if (!r.ok) { if (!quiet || r.status === 400) toast(j.error || 'That did not work.'); return false; }
    accept(j);
    if (j.toast) toast(j.toast);
    return true;
  } catch { if (!quiet) toast('Not connected. Check the network and try again.'); return false; }
}

// Live sync: ask the server about once a second whether anything changed (204 = no change).
let POLL = 0; let VERSION = null; let FAILS = 0;
function connect() {
  const gen = ++POLL; VERSION = null; setConn('connecting');
  const loop = async () => {
    if (gen !== POLL) return;
    try {
      const q = new URLSearchParams({ code: CODE }); if (VERSION != null) q.set('v', VERSION);
      const r = await fetch('/api/state?' + q, { cache: 'no-store' });
      if (gen !== POLL) return;
      if (r.status === 401) { signOut(); toast('Sign in again.'); return; }
      if (r.status === 200) accept(await r.json());
      if (r.ok) { FAILS = 0; setConn('on'); } else throw new Error(r.status);
    } catch { FAILS++; setConn('off'); }
    const wait = document.hidden ? 5000 : Math.min(1000 * 2 ** Math.max(0, FAILS - 1), 8000);
    setTimeout(loop, wait);
  };
  loop();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && CODE) connect(); });
function setConn(s) { const el = $('#conn'); if (el) { el.className = 'conn ' + s; el.textContent = s === 'on' ? 'LIVE' : s === 'off' ? 'RECONNECTING…' : 'CONNECTING…'; } }

async function signIn(code) {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null);
  if (!r) { render(); return toast('Cannot reach the server.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { store.set('ric-code', null); render(); return toast(j.error || 'That code was not recognised.'); }
  CODE = code.trim(); ME = j.me; store.set('ric-code', CODE); connect();
}
function signOut() { POLL++; VERSION = null; CODE = null; ME = null; S = null; store.set('ric-code', null); render(); }

/* ---------- shared bits ---------- */
const ROLE_NAME = { facilitator: 'Facilitator', team: 'Team', panelist: 'Panelist', projector: 'Projector' };
const timerClass = (key, r, big) => {
  if (big && r === 0) return 'done';
  const red = key === 'pitchT' ? 30 : 60, amber = key === 'pitchT' ? 60 : key === 'rootT' ? 120 : 300;
  return r <= red ? 'red' : r <= amber ? 'amber' : '';
};
const timerEl = (key, big) => { const r = remaining(S[key], now()); return `<div class="${big ? 'bigtimer' : 'timer-sm'} ${timerClass(key, r, big)}" data-timer="${key}" ${big ? 'data-big="1"' : ''}>${fmt(r)}</div>`; };
function timerCtl(key) {
  const x = S[key];
  return `<div class="row between">${timerEl(key)}<div class="row">
    ${x.start ? `<button class="btn" data-act="t-pause" data-id="${key}">Pause</button>` : `<button class="btn primary" data-act="t-start" data-id="${key}">${x.acc ? 'Resume' : 'Start ' + fmt(x.dur)}</button>`}
    <button class="btn" data-act="t-add" data-id="${key}">+1 min</button><button class="btn" data-act="t-reset" data-id="${key}">Reset</button></div></div>`;
}
const chDetails = (c) => `<dl class="kv"><dt>Today</dt><dd>${esc(c.problem)}</dd><dt>Affects</dt><dd>${esc(c.affects || '—')}</dd><dt>Why it matters</dt><dd>${esc(c.why || '—')}</dd></dl>`;
const lines = (arr) => arr.filter(Boolean).map((x, i) => `<li><span class="code">Why ${i + 1}</span> ${esc(x)}</li>`).join('');

/* ---------- chrome ---------- */
function renderChrome() {
  document.body.classList.toggle('projector-only', ME?.role === 'projector');
  $('#eyebrow').textContent = S?.event.eyebrow || 'Bank of Maldives · Refresher Training 2026';
  if (!S) { $('#who').innerHTML = ''; $('#roles').innerHTML = ''; $('#stepper').innerHTML = ''; $('#foot').textContent = ''; return; }
  const name = ME.role === 'team' ? team(S, ME.teamId).name : ME.role === 'panelist' ? S.panelists[ME.p].name : ROLE_NAME[ME.role];
  $('#who').innerHTML = `<span class="conn ${FAILS ? 'off' : 'on'}" id="conn">${FAILS ? 'RECONNECTING…' : 'LIVE'}</span><span class="tag">${esc(name)}</span><button class="link" data-act="signout">Sign out</button>`;
  $('#roles').innerHTML = ME.role === 'facilitator'
    ? [['control', 'Control', 'Runs the event'], ['projector', 'Projector preview', 'What the big screen shows'], ['codes', 'Teams & codes', 'Hand out to devices']]
      .map(([id, l, s]) => `<button data-act="view" data-id="${id}" aria-pressed="${VIEW === id}">${l}<small>${s}</small></button>`).join('')
    : '';
  const pi = phaseIdx(S);
  $('#stepper').innerHTML = PHASES.map((p, i) => `<div class="step ${i < pi ? 'done' : i === pi ? 'now' : ''}"><b>${p.label}</b><span>${p.sub}</span></div>`).join('');
  $('#foot').textContent = 'Every device updates live. Keep this page open; it reconnects on its own if the network drops.';
}

/* ---------- sign-in ---------- */
function vLogin() {
  return `<form class="card stack login" data-form="login">
    <div><h2>Sign in</h2><p class="lede">Enter the code you were given. Each team, each panelist, the projector and the facilitator have their own code.</p></div>
    <label class="f">Your code<input type="text" id="login-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. 1-7K2Q" required></label>
    <div class="row"><button class="btn primary" type="submit">Sign in</button></div>
  </form>`;
}

/* ---------- facilitator ---------- */
const demo = (btns) => (SAMPLES ? `<div class="demo"><b>Rehearsal tools</b><div class="row">${btns.map(([a, l]) => `<button class="btn small" data-act="${a}">${l}</button>`).join('')}</div></div>` : '');
function progressBoard(kind) {
  return `<ul class="board">${S.teams.map((t) => {
    const w = workOf(S, t.id); const saved = kind === 'root' ? w.savedRoot : w.savedSol;
    const what = kind === 'root' ? w.root : w.title;
    return `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(what || t.ch?.title || '')}</div></div><span class="code">${saved ? 'Saved ' + esc(saved) : 'Nothing saved yet'}</span></li>`;
  }).join('')}</ul>`;
}
function vFacilitator() {
  if (VIEW === 'projector') return vProjector();
  if (VIEW === 'codes') return vCodes();
  const pi = phaseIdx(S); const n = N();
  let body = '';
  if (S.phase === 'submit') {
    const sub = S.teams.filter((t) => t.ch).length, pend = S.teams.filter((t) => t.ch?.status === 'pending').length;
    body = `<div class="card stack">
      <div><h2>Stage 1 · Challenges</h2><p class="lede">One person from each team enters the team's challenge, then the team explains it to the panel. Either panelist can approve. When all ${n} are approved the challenges lock automatically and appear on the big screen.</p></div>
      <div class="stats"><div class="stat"><b>${sub}/${n}</b><span>Entered</span></div><div class="stat"><b>${pend}</b><span>Waiting for panel</span></div><div class="stat"><b>${approvedCount(S)}/${n}</b><span>Approved</span></div></div>
      <ul class="board">${S.teams.map((t) => `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(t.ch?.title || '—')}</div>${t.ch?.by ? `<div class="code">${t.ch.status === 'approved' ? 'Approved' : 'Sent back'} by ${esc(t.ch.by)}</div>` : ''}</div>${pill(curStatus(t))}</li>`).join('')}</ul>
      ${demo([['demo-submit', 'Enter sample challenges'], ['demo-approve', 'Approve all entered']])}
    </div>`;
  } else if (S.phase === 'locked') {
    body = `<div class="card stack"><div><h2>Challenges locked</h2><p class="lede">All ${n} challenges are confirmed and on the big screen. Start Stage 2 when teams are ready: ${fmt(S.rootT.dur)} for the root cause, then ${fmt(S.solT.dur)} for the solution.</p></div>
      ${lockedList()}
      <div class="row"><button class="btn primary" data-act="phase" data-id="root">Start Stage 2 · Root cause</button></div></div>`;
  } else if (S.phase === 'root') {
    body = `<div class="card stack"><div><h2>Stage 2 · Root cause</h2><p class="lede">Teams ask “why?” up to five times and name the root cause. Their work saves as they type, and saving stops when the timer runs out.</p></div>
      ${timerCtl('rootT')}${progressBoard('root')}
      <div class="row"><button class="btn primary" data-act="phase" data-id="solution">Move to Solution (${fmt(S.solT.dur)})</button></div>
      ${demo([['demo-root', 'Fill sample root causes']])}</div>`;
  } else if (S.phase === 'solution') {
    body = `<div class="card stack"><div><h2>Stage 2 · Solution</h2><p class="lede">Teams design a solution for their root cause. What they write becomes their pitch slide.</p></div>
      ${timerCtl('solT')}${progressBoard('solution')}
      <div class="row"><button class="btn primary" data-act="phase" data-id="pitch">Start pitches</button></div>
      ${demo([['demo-solution', 'Fill sample solutions']])}</div>`;
  } else if (S.phase === 'pitch') {
    const t = S.teams[S.pitchIdx];
    body = `<div class="card stack"><div><h2>Pitches · ${S.pitchIdx + 1} of ${n}</h2><p class="lede">On stage: <b>${esc(t.name)}</b>. The big screen shows their challenge, root cause and solution with the countdown.</p></div>
      ${timerCtl('pitchT')}
      <div class="row"><button class="btn" data-act="prev-team" ${S.pitchIdx ? '' : 'disabled'}>Previous team</button>
      ${S.pitchIdx < n - 1 ? `<button class="btn primary" data-act="next-team">Next team</button>` : '<span class="lede" style="margin:0">This is the last team.</span>'}</div>
      <ul class="board">${S.teams.map((tt, i) => `<li><div class="t"><b>${i + 1}. ${esc(tt.name)}</b><div>${esc(workOf(S, tt.id).title || tt.ch?.title)}</div></div>${i === S.pitchIdx ? '<span class="now-badge">On stage</span>' : i < S.pitchIdx ? '<span class="code">Done</span>' : ''}</li>`).join('')}</ul>
      <div class="row"><button class="btn" data-act="export">Download everything (CSV)</button></div></div>`;
  }
  return `<div class="grid g2">${body}
    <div class="stack"><div class="card"><h3>Event stages</h3><p class="lede">Moves every screen to the selected stage at once.</p>
      <div class="stack">${PHASES.map((p, i) => `<button class="btn ${i === pi ? 'primary' : ''} small" style="text-align:left" data-act="phase" data-id="${p.id}" ${(p.id !== 'submit' && !S.locked && !(p.id === 'locked' && allApproved(S))) ? 'disabled' : ''}>${i + 1}. ${p.label}</button>`).join('')}</div>
      ${!S.locked ? '<p class="lede" style="margin:10px 0 0;font-size:13px">Stage 2 opens once every challenge is approved.</p>' : S.phase !== 'submit' ? '<p class="lede" style="margin:10px 0 0;font-size:13px">Going back to Challenges unlocks them for changes.</p>' : ''}</div>
      <div class="card stack"><h3>Start over</h3><p class="lede" style="margin:0">Clears every challenge, root cause and solution. Sign-in codes stay the same.</p>
      <div><button class="btn bad small" data-act="reset-round">Reset event</button></div></div></div></div>`;
}
function lockedList() { return `<ul class="board">${S.teams.map((t) => `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(t.ch?.title)}</div></div><span class="tag">${esc(t.ch?.cat)}</span></li>`).join('')}</ul>`; }
function vCodes() {
  const link = (c) => `${location.origin}/?code=${encodeURIComponent(c)}`;
  const row = (who, code, note) => `<li><div class="t"><b>${esc(who)}</b>${note ? `<div class="code">${esc(note)}</div>` : ''}</div><div style="text-align:right"><div class="code" style="font-size:15px;color:var(--ink)">${esc(code)}</div><button class="link" data-act="copy" data-id="${esc(link(code))}">Copy sign-in link</button></div></li>`;
  return `<div class="grid g2"><div class="card stack"><div><h2>Teams</h2><p class="lede">Each device opens <b>${esc(location.origin)}</b> and signs in with its code, or opens its sign-in link. One device per team, used by the team's representative.</p></div>
    <ul class="board">${S.teams.map((t) => `<li style="flex-wrap:wrap"><div class="t row" style="flex:1 1 220px">
      <input type="text" id="name-${t.id}" maxlength="40" value="${esc(t.name)}" aria-label="Team name" style="max-width:220px">
      <button class="btn small" data-act="rename" data-id="${t.id}">Rename</button></div>
      <div style="text-align:right"><div class="code" style="font-size:15px;color:var(--ink)">${esc(t.code)}</div><button class="link" data-act="copy" data-id="${esc(link(t.code))}">Copy sign-in link</button></div></li>`).join('')}</ul></div>
    <div class="stack"><div class="card"><h3>Staff</h3><ul class="board">
      ${row('Facilitator', S.auth.facilitator, 'This device')}${row('Projector', S.auth.projector, 'Big screen, read only')}
      ${S.panelists.map((j) => row(j.name, j.code, 'Approves challenges')).join('')}</ul></div></div></div>`;
}

/* ---------- team ---------- */
function chForm(c) {
  c = c || {};
  return `<div class="fgrid">
   <label class="f full">Challenge title <em>One line the panel can read at a glance</em><input type="text" id="p-title" maxlength="160" value="${esc(c.title)}" required></label>
   <fieldset class="full"><legend>Type of challenge</legend><div class="row">${CATS.map((x, i) => `<label class="radio"><input type="radio" name="p-cat" id="p-cat-${i}" value="${esc(x)}" ${(c.cat || CATS[0]) === x ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div></fieldset>
   <label class="f full">What happens today? <em>The problem, in two or three sentences</em><textarea id="p-problem" maxlength="1200" required>${esc(c.problem)}</textarea></label>
   <label class="f">Who does it affect?<input type="text" id="p-affects" maxlength="160" value="${esc(c.affects)}"></label>
   <label class="f">Why it matters <em>complaints, delays, cost, lost sales</em><input type="text" id="p-why" maxlength="1200" value="${esc(c.why)}"></label>
  </div>`;
}
function readForm() {
  const g = (k) => document.getElementById('p-' + k)?.value.trim() || '';
  return { title: g('title'), cat: document.querySelector('input[name="p-cat"]:checked')?.value || CATS[0], problem: g('problem'), affects: g('affects'), why: g('why') };
}
function titleBoard(t) {
  const items = S.teams.filter((o) => o.ch).map((o) => `<li><div class="t"><div>${esc(o.ch.title)}</div><span class="code">${esc(o.name)}${o === t ? ' · you' : ''}</span></div>${pill(o.ch.status)}</li>`).join('');
  return `<div class="card"><h3>Challenges entered so far</h3><p class="lede">Pick something different from the other teams.</p><ul class="board">${items || '<li>None yet.</li>'}</ul></div>`;
}
function workTimer(key, label) {
  const up = timeUp(S[key], now());
  return `<div><div class="eyebrow">${up ? 'Time is up' : label}</div>${timerEl(key)}</div>`;
}
function vTeam() {
  const t = team(S, ME.teamId);
  const head = `<div class="card row between"><div><div class="eyebrow">This device is signed in as</div><h3>${esc(t.name)} <span class="code">${esc(t.code || '')}</span></h3></div></div>`;
  const c = t.ch;
  if (S.phase === 'submit') {
    let main;
    if (!c || c.status === 'refine') {
      main = `<form class="card stack" data-form="${c ? 'resubmit' : 'submit'}"><div><h2>${c ? 'The panel sent your challenge back' : 'Enter your team\'s challenge'}</h2>
        <p class="lede">${c ? 'Update it and resubmit, then explain it to the panel again.' : 'It can be an internal process, a customer pain point or a new way to serve customers. Your team can enter only one challenge, so agree on it first.'}</p></div>
        ${c ? `<div class="note"><b>${esc(c.by || 'Panel')}:</b> ${esc(c.note)}</div>` : ''}
        ${chForm(c)}
        <div class="row"><button class="btn primary" type="submit">${c ? 'Resubmit to the panel' : 'Enter challenge'}</button></div></form>`;
    } else {
      main = `<div class="card stack"><div class="row between"><h2>Your challenge</h2>${pill(c.status)}</div>
        <h3>${esc(c.title)}</h3><div><span class="tag">${esc(c.cat)}</span></div>${chDetails(c)}
        ${c.status === 'approved'
          ? `<div class="note ok"><b>Approved by ${esc(c.by)}.</b> When every team's challenge is approved, they lock and Stage 2 begins.</div>`
          : '<div class="note info"><b>Next:</b> come up to the panel and explain your challenge. This screen updates as soon as they confirm it.</div>'}</div>`;
    }
    return `${head}<div class="grid g2" style="margin-top:16px">${main}${titleBoard(t)}</div>`;
  }
  if (S.phase === 'locked') {
    return `${head}<div class="grid g2" style="margin-top:16px"><div class="card stack"><h2>Your challenge is locked in</h2><h3>${esc(c?.title)}</h3>${c ? chDetails(c) : ''}
      <p class="lede" style="margin:0">Next is Stage 2. You will have ${fmt(S.rootT.dur)} to find the root cause, then ${fmt(S.solT.dur)} to build the solution.</p></div>
      <div class="card"><h3>All ${N()} challenges</h3>${lockedList()}</div></div>`;
  }
  const w = workOf(S, t.id);
  const chBox = `<div class="note info"><b>Your challenge:</b> ${esc(c?.title)} <span class="tag">${esc(c?.cat)}</span></div>`;
  if (S.phase === 'root') {
    const ro = timeUp(S.rootT, now());
    return `${head}<form class="card stack" style="margin-top:16px" data-form="root" data-autosave="save-root">
      <div class="row between"><div><h2>Find the root cause</h2><p class="lede">Start with the problem and keep asking “why does this happen?”. Stop when you reach something you can act on. Your work saves as you type.</p></div>${workTimer('rootT', 'Root cause time left')}</div>
      ${chBox}
      <div class="stack">${Array.from({ length: WHYS }, (_, i) => `<label class="f">Why ${i + 1}?<input type="text" id="w-why-${i}" maxlength="1200" value="${esc(w.whys[i])}" ${ro ? 'disabled' : ''} placeholder="${i === 0 ? 'Why does the problem happen?' : 'Why is that?'}"></label>`).join('')}</div>
      <label class="f">Our root cause <em>One sentence: the real reason behind the problem</em><textarea id="w-root" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(w.root)}</textarea></label>
      ${saveRow(ro, w.savedRoot, 'w-')}</form>`;
  }
  if (S.phase === 'solution') {
    const ro = timeUp(S.solT, now());
    return `${head}<form class="card stack" style="margin-top:16px" data-form="solution" data-autosave="save-solution">
      <div class="row between"><div><h2>Build your solution</h2><p class="lede">Solve the root cause, not just the symptom. This becomes your slide on the big screen when you pitch.</p></div>${workTimer('solT', 'Solution time left')}</div>
      ${chBox}<div class="note"><b>Root cause:</b> ${esc(w.root || 'Not filled in')}</div>
      <div class="fgrid">
        <label class="f full">Solution name<input type="text" id="s-title" maxlength="160" value="${esc(w.title)}" ${ro ? 'disabled' : ''}></label>
        <label class="f full">What will you do? <em>The idea, in plain words</em><textarea id="s-approach" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(w.approach)}</textarea></label>
        <label class="f full">How will it work? <em>Steps, owners, timeline, what you need</em><textarea id="s-impl" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(w.impl)}</textarea></label>
        <label class="f full">Expected impact <em>For customers and for the bank, with numbers if you have them</em><textarea id="s-benefits" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(w.benefits)}</textarea></label>
      </div>
      ${saveRow(ro, w.savedSol, 's-')}</form>`;
  }
  const onStage = S.phase === 'pitch' && S.teams[S.pitchIdx]?.id === t.id;
  return `${head}<div class="card stack" style="margin-top:16px"><div class="row between"><h2>Your pitch</h2>${onStage ? '<span class="now-badge">You are on stage</span>' : '<span class="pill p-none">Locked</span>'}</div>
    ${summary(t, w)}</div>`;
}
function saveRow(ro, saved, prefix) {
  if (ro) return `<div class="note bad">Time is up. Your work was saved${saved ? ' at ' + esc(saved) : ''}.</div>`;
  const dirty = Object.keys(drafts).some((k) => k.startsWith(prefix));
  return `<div class="row"><button class="btn primary" type="submit">Save now</button><span class="code" id="save-state">${dirty ? 'Saving…' : saved ? 'All changes saved · ' + esc(saved) : 'Not saved yet'}</span></div>`;
}
function summary(t, w) {
  const c = t.ch || {};
  return `<dl class="kv"><dt>Challenge</dt><dd><b>${esc(c.title)}</b> <span class="tag">${esc(c.cat)}</span><br>${esc(c.problem)}</dd>
    <dt>Five whys</dt><dd><ol class="whys">${lines(w.whys) || '<li>—</li>'}</ol></dd>
    <dt>Root cause</dt><dd>${esc(w.root || '—')}</dd>
    <dt>Solution</dt><dd><b>${esc(w.title || '—')}</b><br>${esc(w.approach)}</dd>
    <dt>How it works</dt><dd>${esc(w.impl || '—')}</dd><dt>Expected impact</dt><dd>${esc(w.benefits || '—')}</dd></dl>`;
}

/* ---------- panelist ---------- */
function vPanelist() {
  const me = S.panelists[ME.p]; const n = N();
  const head = `<div class="card row between"><div><div class="eyebrow">Signed in as</div><h3>${esc(me.name)}</h3></div><div class="stats"><div class="stat"><b>${approvedCount(S)}/${n}</b><span>Approved</span></div></div></div>`;
  if (S.phase === 'submit') {
    const order = { pending: 0, refine: 1, none: 2, approved: 3 };
    const list = [...S.teams].sort((a, b) => (order[curStatus(a)] ?? 2) - (order[curStatus(b)] ?? 2));
    const cards = list.map((t) => {
      const c = t.ch;
      if (!c) return `<div class="qcard is-none"><div class="row between"><h3>${esc(t.name)}</h3>${pill('none')}</div><p class="lede" style="margin:0">Nothing entered yet.</p></div>`;
      return `<div class="qcard is-${c.status}">
        <div class="row between"><div><span class="eyebrow">${esc(t.name)} · ${esc(c.ts)}</span><h3>${esc(c.title)}</h3></div>${pill(c.status)}</div>
        <div><span class="tag">${esc(c.cat)}</span></div>${chDetails(c)}
        ${c.status === 'refine' ? `<div class="note">Sent back by ${esc(c.by)}: ${esc(c.note)}</div>` : ''}
        ${c.status === 'pending' ? `
          <div class="row"><button class="btn ok" data-act="approve" data-id="${t.id}">Approve challenge</button></div>
          <label class="f">Or send it back <em>tell the team what to change</em><input type="text" id="note-${t.id}" maxlength="300" placeholder="e.g. Too broad. Focus on one product or one process."></label>
          <div class="row"><button class="btn warn small" data-act="refine" data-id="${t.id}">Send back to the team</button></div>` : ''}
        ${c.status === 'approved' ? `<div class="row between"><span class="code">Approved by ${esc(c.by)}</span><button class="link" data-act="undo" data-id="${t.id}">Undo approval</button></div>` : ''}
      </div>`;
    }).join('');
    return `${head}<div class="grid g2" style="margin-top:16px"><div class="stack">${cards}</div>
      <div class="stack"><div class="card"><h3>How approval works</h3><ul class="plain">
        <li>Each team enters one challenge, then explains it to you.</li><li>Either panelist can approve. One approval is enough.</li>
        <li>When all ${n} are approved, the challenges lock and show on the big screen.</li></ul></div>
        <div class="card"><h3>A good challenge is</h3><ul class="plain"><li>A real problem for customers or staff</li><li>Specific enough to solve in 20 minutes</li><li>Something the team can influence</li><li>Different from the other teams' challenges</li></ul></div></div></div>`;
  }
  if (S.phase !== 'pitch') {
    const cards = S.teams.map((t) => { const w = workOf(S, t.id); return `<div class="card stack"><div><span class="eyebrow">${esc(t.name)}</span><h3>${esc(t.ch?.title)}</h3></div>
      <dl class="kv"><dt>Root cause</dt><dd>${esc(w.root || '—')}</dd><dt>Solution</dt><dd>${esc(w.title || '—')}</dd></dl></div>`; }).join('');
    return `${head}<div class="grid g2" style="margin-top:16px"><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))">${cards}</div>
      <div class="card"><h3>Next: the pitches</h3><p class="lede" style="margin:0">Each team presents its challenge, root cause and solution. The panel then chooses the best challenge and solution.</p></div></div>`;
  }
  const cards = S.teams.map((t, i) => {
    const w = workOf(S, t.id); const onStage = i === S.pitchIdx;
    return `<div class="card stack" ${onStage ? 'style="border-color:var(--accent)"' : ''}>
      <div class="row between"><div><span class="eyebrow">Pitch ${i + 1} · ${esc(t.name)}</span><h3>${esc(w.title || t.ch?.title)}</h3></div>
      ${onStage ? '<span class="now-badge">On stage</span>' : ''}</div>
      ${onStage ? summary(t, w) : `<details id="det-${t.id}"><summary>Challenge, root cause and solution</summary>${summary(t, w)}</details>`}</div>`;
  }).join('');
  return head + `<div class="grid" style="margin-top:16px;align-items:start;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))">${cards}</div>`;
}

/* ---------- projector ---------- */
function vProjector() {
  let inner = ''; const n = N();
  const fs = ME.role === 'projector' ? `<button class="btn small" data-act="fullscreen">Full screen</button>` : '';
  const top = (eyebrow, h) => `<div class="row between"><div><div class="eyebrow">${eyebrow}</div><h2>${h}</h2></div>${fs}</div>`;
  if (S.phase === 'submit') {
    inner = `${top('Stage 1', 'Team challenges')}
     <div class="ptiles">${S.teams.map((t) => { const st = curStatus(t);
      return `<div class="ptile ${st === 'approved' ? 'ok' : ''}"><span class="tm">${esc(t.name)}</span><span class="ch ${t.ch ? '' : 'empty'}">${t.ch ? esc(t.ch.title) : 'Waiting for the challenge'}</span><span class="st">${t.ch ? esc(t.ch.cat) + ' · ' : ''}${st === 'approved' ? '✓ Approved' : statusLabel[st]}</span></div>`; }).join('')}</div>
     <div class="eyebrow">${approvedCount(S)} of ${n} approved</div>`;
  } else if (S.phase === 'locked') {
    inner = `${top('Stage 1 complete', `🔒 All ${n} challenges locked`)}
     <div class="ptiles">${S.teams.map((t) => `<div class="ptile ok"><span class="tm">${esc(t.name)}</span><span class="ch">${esc(t.ch?.title)}</span><span class="st">${esc(t.ch?.cat)}</span></div>`).join('')}</div>`;
  } else if (S.phase === 'root' || S.phase === 'solution') {
    const isRoot = S.phase === 'root'; const key = isRoot ? 'rootT' : 'solT';
    inner = `${top('Stage 2', isRoot ? 'Find the root cause' : 'Build the solution')}
     ${timerEl(key, true)}
     <div class="ptiles">${S.teams.map((t) => { const w = S.work[t.id] || {}; const done = isRoot ? w.hasRoot || w.root : w.hasSolution || (w.title && w.approach);
      return `<div class="ptile ${done ? 'ok' : ''}"><span class="tm">${esc(t.name)}</span><span class="ch" style="font-size:19px">${esc(t.ch?.title)}</span><span class="st">${done ? (isRoot ? '✓ Root cause identified' : '✓ Solution drafted') : 'Working…'}</span></div>`; }).join('')}</div>`;
  } else if (S.phase === 'pitch') {
    const t = S.teams[S.pitchIdx]; const w = workOf(S, t.id); const c = t.ch || {};
    const box = (h, v) => `<div class="pbox"><h4>${h}</h4><p>${v ? esc(v) : '<span style="opacity:.5">Not filled in</span>'}</p></div>`;
    inner = `<div class="row between"><div class="eyebrow">Pitch ${S.pitchIdx + 1} of ${n} · ${esc(t.name)}</div>${fs}</div>
     <div class="pitch"><div class="stack"><h2>${esc(w.title || c.title)}</h2>
       ${box('Challenge · ' + esc(c.cat), [c.title, c.problem].filter(Boolean).join(' — '))}${box('Root cause', w.root)}${box('Solution', w.approach)}${box('How it works', w.impl)}${box('Expected impact', w.benefits)}</div>
       <div class="stack"><div class="eyebrow">Time remaining</div>${timerEl('pitchT', true)}</div></div>`;
  }
  return `<div class="proj">${inner}<div class="brand">${esc(S.event.eyebrow)}</div></div>`;
}

/* ---------- render (keeps unsaved input and focus across live updates) ---------- */
function render() {
  const f = document.activeElement; const fid = f?.id; let sel = null;
  try { if (fid && 'selectionStart' in f) sel = [f.selectionStart, f.selectionEnd]; } catch {}
  renderChrome();
  if (!S) { $('#app').innerHTML = vLogin(); $('#login-code')?.focus(); return; }
  const v = { facilitator: vFacilitator, team: vTeam, panelist: vPanelist, projector: vProjector }[ME.role];
  const open = [...document.querySelectorAll('details[open]')].map((d) => d.id);
  $('#app').innerHTML = v();
  for (const [id, val] of Object.entries(drafts)) {
    const el = document.getElementById(id); if (!el || el.disabled) continue;
    if (el.type === 'radio') el.checked = val === true; else el.value = val;
  }
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} } }
  open.forEach((id) => { const d = id && document.getElementById(id); if (d) d.open = true; });
}
let LAST_UP = null;
function tick() {
  if (!S) return;
  document.querySelectorAll('[data-timer]').forEach((el) => {
    const key = el.dataset.timer; const r = remaining(S[key], now());
    el.textContent = fmt(r);
    el.classList.remove('amber', 'red', 'done');
    const cls = timerClass(key, r, !!el.dataset.big); if (cls) el.classList.add(cls);
  });
  // Teams: when time runs out, push any unsaved typing and lock the form.
  if (ME?.role === 'team' && TIMER_OF[S.phase] && S.phase !== 'pitch') {
    const up = timeUp(S[TIMER_OF[S.phase]], now());
    if (up !== LAST_UP) { const was = LAST_UP; LAST_UP = up; if (up && was === false) flushSave().then(render); else if (was !== null) render(); }
  } else LAST_UP = null;
}
setInterval(tick, 250);

/* ---------- autosave (root cause & solution) ---------- */
let saveTimer = null; let saving = null;
function readWork(kind) {
  const g = (id) => document.getElementById(id)?.value ?? '';
  if (kind === 'save-root') return { whys: Array.from({ length: WHYS }, (_, i) => g('w-why-' + i)), root: g('w-root') };
  return { title: g('s-title'), approach: g('s-approach'), impl: g('s-impl'), benefits: g('s-benefits') };
}
async function flushSave(quiet = true) {
  clearTimeout(saveTimer); saveTimer = null;
  const form = document.querySelector('form[data-autosave]'); if (!form) return;
  const kind = form.dataset.autosave; const prefix = kind === 'save-root' ? 'w-' : 's-';
  if (quiet && !Object.keys(drafts).some((k) => k.startsWith(prefix))) return;
  const snap = Object.fromEntries(Object.entries(drafts).filter(([k]) => k.startsWith(prefix)));
  const w = readWork(kind);
  await saving;
  saving = send({ type: kind, w, quiet }, { quiet });
  const ok = await saving; saving = null;
  if (ok) { for (const [k, v] of Object.entries(snap)) if (drafts[k] === v) delete drafts[k]; render(); }
}
function scheduleSave() {
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushSave(true), 1200);
  const el = document.getElementById('save-state'); if (el) el.textContent = 'Saving…';
}

/* ---------- export ---------- */
function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Pitch order', 'Team', 'Type', 'Challenge', 'What happens today', 'Affects', 'Why it matters', 'Approved by',
    ...Array.from({ length: WHYS }, (_, i) => 'Why ' + (i + 1)), 'Root cause', 'Solution', 'What we will do', 'How it works', 'Expected impact'];
  const out = [head.map(q).join(',')];
  S.teams.forEach((t, i) => { const c = t.ch || {}; const w = workOf(S, t.id);
    out.push([i + 1, t.name, c.cat, c.title, c.problem, c.affects, c.why, c.by, ...w.whys, w.root, w.title, w.approach, w.impl, w.benefits].map(q).join(',')); });
  const blob = new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'innovation-challenge-2026.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- events ---------- */
const clearDrafts = (prefix) => Object.keys(drafts).forEach((k) => { if (k.startsWith(prefix)) delete drafts[k]; });
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.id || el.id === 'login-code' || !el.matches('input,textarea,select')) return;
  if (el.type === 'radio') { document.querySelectorAll(`input[name="${el.name}"]`).forEach((r) => (drafts[r.id] = r.checked)); return; }
  drafts[el.id] = el.value;
  if (el.closest('form[data-autosave]')) scheduleSave();
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'signout': if (confirm('Sign this device out?')) signOut(); return;
    case 'view': VIEW = id; render(); return;
    case 'export': exportCSV(); return;
    case 'fullscreen': document.documentElement.requestFullscreen?.().catch(() => {}); return;
    case 'copy': navigator.clipboard?.writeText(id).then(() => toast('Sign-in link copied.'), () => prompt('Copy this link:', id)); return;
    case 'reset-round': if (!confirm('Reset the whole event? This clears every challenge, root cause and solution on every device.')) return; break;
    case 'demo-submit': case 'demo-approve': case 'demo-root': case 'demo-solution': if (!confirm('Add rehearsal sample data to the live event?')) return; break;
    case 'phase':
      if (id === 'submit' && S.locked && !confirm('Go back to Stage 1? This unlocks the challenges so the panel can change them.')) return;
      break;
    case 'rename': { const name = document.getElementById('name-' + id)?.value || ''; if (await send({ type: 'rename', id, name })) { clearDrafts('name-' + id); render(); } return; }
    case 'refine': { const note = document.getElementById('note-' + id)?.value.trim() || ''; if (await send({ type: a, id, note })) { clearDrafts('note-' + id); render(); } return; }
  }
  send({ type: a, id });
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const f = form.dataset.form;
  if (f === 'login') return signIn($('#login-code').value);
  if (form.dataset.autosave) return flushSave(false);
  const p = readForm();
  if (!p.title) return toast('Add a challenge title.');
  if (!p.problem) return toast('Describe what happens today.');
  if (f === 'submit' && !confirm('Enter this as your team\'s challenge? Each team can enter only one.')) return;
  if (await send({ type: f, p })) { clearDrafts('p-'); render(); }
});

// Ctrl/Cmd+S saves straight away.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { const form = document.querySelector('form[data-autosave]'); if (form) { e.preventDefault(); flushSave(false); } }
});
window.addEventListener('beforeunload', (e) => { if (Object.keys(drafts).some((k) => /^(w|s|p)-/.test(k))) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- boot ---------- */
const params = new URLSearchParams(location.search);
const urlCode = params.get('code');
if (urlCode) history.replaceState(null, '', location.pathname);
CODE = urlCode || store.get('ric-code');
if (CODE) signIn(CODE); else render();
