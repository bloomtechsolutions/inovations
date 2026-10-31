import {
  CATS, STAGES, CRIT, PHASES, statusLabel, team, act, teamState, curStatus, similarTo,
  approvedCount, allApproved, phaseIdx, remaining, fmt, canvasOf, judgeTotal, results,
} from '/shared/logic.js';

/* ---------- client state ---------- */
let S = null;            // server state (redacted for this device)
let ME = null;           // { role, teamId?, judge? }
let CODE = null;         // sign-in code for this device
let OFFSET = 0;          // server clock - local clock
let SAMPLES = false;     // rehearsal tools enabled on server
let VIEW = 'control';    // facilitator tab
let ES = null;
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
async function send(a) {
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-code': CODE }, body: JSON.stringify(a) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut(); toast(j.error || 'Sign in again.'); return false; }
    if (!r.ok) { toast(j.error || 'That did not work.'); return false; }
    if (j.toast) toast(j.toast);
    return true;
  } catch { toast('Not connected. Check the network and try again.'); return false; }
}

function connect() {
  ES?.close();
  setConn('connecting');
  ES = new EventSource('/api/events?code=' + encodeURIComponent(CODE));
  ES.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    S = d.state; ME = d.me; SAMPLES = d.samples; OFFSET = d.now - Date.now();
    setConn('on'); render();
  });
  ES.onerror = async () => {
    setConn('off');
    // A rejected code (e.g. after an event reset) shouldn't retry forever.
    try { const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE }) }); if (r.status === 401) signOut(); } catch {}
  };
}
function setConn(s) { const el = $('#conn'); if (el) { el.className = 'conn ' + s; el.textContent = s === 'on' ? 'LIVE' : s === 'off' ? 'RECONNECTING…' : 'CONNECTING…'; } }

async function signIn(code) {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null);
  if (!r) { render(); return toast('Cannot reach the server.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { store.set('ric-code', null); render(); return toast(j.error || 'That code was not recognised.'); }
  CODE = code.trim(); ME = j.me; store.set('ric-code', CODE); connect();
}
function signOut() { ES?.close(); ES = null; CODE = null; ME = null; S = null; store.set('ric-code', null); render(); }

/* ---------- chrome ---------- */
const ROLE_NAME = { facilitator: 'Facilitator', team: 'Team', panel: 'Review panel', judge: 'Judge', projector: 'Projector' };
function renderChrome() {
  document.body.classList.toggle('projector-only', ME?.role === 'projector');
  $('#eyebrow').textContent = S?.event.eyebrow || 'Live event';
  if (!S) { $('#who').innerHTML = ''; $('#roles').innerHTML = ''; $('#stepper').innerHTML = ''; $('#foot').textContent = ''; return; }
  const name = ME.role === 'team' ? team(S, ME.teamId).name : ME.role === 'judge' ? S.judges[ME.judge].name : ROLE_NAME[ME.role];
  $('#who').innerHTML = `<span class="conn on" id="conn">LIVE</span><span class="tag">${esc(name)}</span><button class="link" data-act="signout">Sign out</button>`;
  $('#roles').innerHTML = ME.role === 'facilitator'
    ? [['control', 'Control', 'Runs the session'], ['projector', 'Projector preview', 'What the big screen shows'], ['codes', 'Sign-in codes', 'Hand out to devices']]
      .map(([id, l, s]) => `<button data-act="view" data-id="${id}" aria-pressed="${VIEW === id}">${l}<small>${s}</small></button>`).join('')
    : '';
  const pi = phaseIdx(S);
  $('#stepper').innerHTML = PHASES.map((p, i) => `<div class="step ${i < pi ? 'done' : i === pi ? 'now' : ''}"><b>${p.label}</b><span>${p.sub}</span></div>`).join('');
  $('#foot').textContent = 'Every device updates live. Keep this page open; it reconnects on its own if the network drops.';
}

/* ---------- sign-in ---------- */
function vLogin() {
  return `<form class="card stack login" data-form="login">
    <div><h2>Sign in</h2><p class="lede">Enter the code you were given. Teams, judges, the review panel, the projector and the facilitator each have their own code.</p></div>
    <label class="f">Your code<input type="text" id="login-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. ADD-7K2Q" required></label>
    <div class="row"><button class="btn primary" type="submit">Sign in</button></div>
    <p class="lede" style="margin:0;font-size:13px">Facilitator: your code is printed in the server console when it starts.</p>
  </form>`;
}

/* ---------- facilitator ---------- */
const demo = (act, label) => (SAMPLES ? `<div class="demo"><b>Rehearsal tools</b><div class="row"><button class="btn small" data-act="${act}">${label}</button></div></div>` : '');
function vFacilitator() {
  if (VIEW === 'projector') return vProjector();
  if (VIEW === 'codes') return vCodes();
  const pi = phaseIdx(S); const n = N();
  const counts = { sub: S.teams.filter((t) => t.primary).length, pend: S.teams.filter((t) => act(t)?.status === 'pending').length, appr: approvedCount(S) };
  let body = '';
  if (S.phase === 's5') {
    body = `<div class="card stack">
      <div><h2>Session 05 · Challenge submissions</h2><p class="lede">Teams submit a primary challenge and a backup during “Reimagine the Customer Journey”. The panel approves one distinct challenge per team. Lock the list once all ${n} are approved.</p></div>
      <div class="stats"><div class="stat"><b>${counts.sub}/${n}</b><span>Teams submitted</span></div><div class="stat"><b>${counts.pend}</b><span>Waiting for panel</span></div><div class="stat"><b>${counts.appr}/${n}</b><span>Approved</span></div></div>
      <ul class="board">${S.teams.map((t) => `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(act(t)?.title || '—')}</div></div>${pill(curStatus(t))}</li>`).join('')}</ul>
      <div class="row"><button class="btn primary" data-act="lock" ${allApproved(S) ? '' : 'disabled'}>Lock challenges &amp; publish</button>
      ${allApproved(S) ? '' : `<span class="lede" style="margin:0">Unlocks when all ${n} teams have an approved challenge.</span>`}</div>
      ${demo('demo-s5', 'Add sample submissions and approve them')}
    </div>`;
  } else if (S.phase === 'locked') {
    body = `<div class="card stack"><div><h2>Challenges locked</h2><p class="lede">The challenges are published on the projector and copied into each team's proposal canvas. Start the sprint at 16:03.</p></div>
      ${lockedList()}
      <div class="row"><button class="btn primary" data-act="phase" data-id="sprint">Open Session 10 · Ideation sprint</button></div></div>`;
  } else if (S.phase === 'sprint') {
    const r = remaining(S.sprint, now()); const filled = S.teams.filter((t) => { const c = canvasOf(S, t.id); return c.approach && c.impl && c.benefits; }).length;
    body = `<div class="card stack"><div><h2>Ideation sprint</h2><p class="lede">Teams complete Approach, Implementation and Expected Benefits on their canvas. The challenge is already filled in.</p></div>
      <div class="row between"><div class="timer-sm" data-timer="sprint">${fmt(r)}</div>
      <div class="row">${S.sprint.start ? `<button class="btn" data-act="t-pause" data-id="sprint">Pause</button>` : `<button class="btn primary" data-act="t-start" data-id="sprint">${S.sprint.acc ? 'Resume' : 'Start ' + fmt(S.sprint.dur)}</button>`}<button class="btn" data-act="t-reset" data-id="sprint">Reset</button></div></div>
      <div class="stats"><div class="stat"><b>${filled}/${n}</b><span>Canvases complete</span></div></div>
      <ul class="board">${S.teams.map((t) => { const c = canvasOf(S, t.id); return `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(c.title || 'No pitch title yet')}</div></div><span class="code">${c.saved ? 'Saved ' + esc(c.saved) : 'Not saved'}</span></li>`; }).join('')}</ul>
      <div class="row"><button class="btn primary" data-act="phase" data-id="pitch">Start pitches</button></div>
      ${demo('demo-canvas', 'Fill sample canvases for all teams')}</div>`;
  } else if (S.phase === 'pitch') {
    const t = S.teams[S.pitchIdx]; const r = remaining(S.pitchT, now());
    const sc = S.teams.map((tt, i) => `<tr><td>${i + 1}</td><td>${esc(tt.name)}${i === S.pitchIdx ? ' <span class="now-badge">On stage</span>' : ''}</td>${S.judges.map((_, j) => `<td>${S.scores[j]?.[tt.id]?.submitted ? '✓' : '–'}</td>`).join('')}</tr>`).join('');
    body = `<div class="card stack"><div><h2>Pitches · ${S.pitchIdx + 1} of ${n}</h2><p class="lede">On stage: <b>${esc(t.name)}</b>. Three minutes each. The projector shows their canvas and the countdown.</p></div>
      <div class="row between"><div class="timer-sm ${r <= 30 ? 'red' : r <= 60 ? 'amber' : ''}" data-timer="pitch">${fmt(r)}</div>
      <div class="row">${S.pitchT.start ? `<button class="btn" data-act="t-pause" data-id="pitchT">Pause</button>` : `<button class="btn primary" data-act="t-start" data-id="pitchT">${S.pitchT.acc ? 'Resume' : 'Start ' + fmt(S.pitchT.dur)}</button>`}
      <button class="btn" data-act="prev-team" ${S.pitchIdx ? '' : 'disabled'}>Previous</button>
      ${S.pitchIdx < n - 1 ? `<button class="btn primary" data-act="next-team">Next team</button>` : `<button class="btn primary" data-act="phase" data-id="results">Go to results</button>`}</div></div>
      <div class="tbl"><table class="t"><thead><tr><th>#</th><th>Team</th>${S.judges.map((j) => `<th>${esc(j.name)}</th>`).join('')}</tr></thead><tbody>${sc}</tbody></table></div>
      ${demo('demo-scores', 'Fill sample scores for all but the last judge')}</div>`;
  } else {
    const res = results(S);
    const rows = res.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.t.name)}</td><td>${esc(act(r.t)?.title)}</td><td class="n">${r.avg.toFixed(1)}</td><td class="n">${r.n}/${S.judges.length}</td></tr>`).join('');
    body = `<div class="card stack"><div><h2>Results</h2><p class="lede">Reveal from last place up. Scores are the weighted average of all submitted judges, out of 100.</p></div>
      <div class="row"><button class="btn primary" data-act="reveal" ${S.reveal >= n ? 'disabled' : ''}>${S.reveal === 0 ? `Reveal ${ordinal(n)} place` : S.reveal >= n ? 'All revealed' : S.reveal === n - 1 ? 'Reveal the winner' : 'Reveal next'}</button>
      <button class="btn" data-act="reveal-reset">Hide all</button><button class="btn" data-act="export">Download results (CSV)</button></div>
      <div class="tbl"><table class="t"><thead><tr><th>Rank</th><th>Team</th><th>Challenge</th><th style="text-align:right">Score</th><th style="text-align:right">Judges</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  return `<div class="grid g2">${body}
    <div class="stack"><div class="card"><h3>Session controls</h3><p class="lede">Moves every screen to the selected stage at once.</p>
      <div class="stack">${PHASES.map((p, i) => `<button class="btn ${i === pi ? 'primary' : ''} small" style="text-align:left" data-act="phase" data-id="${p.id}" ${(p.id !== 's5' && !S.locked && !(p.id === 'locked' && allApproved(S))) ? 'disabled' : ''}>${i + 1}. ${p.label}</button>`).join('')}</div>
      ${!S.locked ? '<p class="lede" style="margin:10px 0 0;font-size:13px">Session 10 stages open after the challenges are locked.</p>' : ''}</div>
      <div class="card stack"><h3>Start over</h3><p class="lede" style="margin:0">Clears every submission, canvas and score. Sign-in codes stay the same.</p>
      <div><button class="btn bad small" data-act="reset-round">Reset event</button></div></div></div></div>`;
}
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
function lockedList() { return `<ul class="board">${S.teams.map((t) => `<li><div class="t"><b>${esc(t.name)}</b><div>${esc(act(t).title)}</div></div><span class="tag">${esc(act(t).cat)}</span></li>`).join('')}</ul>`; }
function vCodes() {
  const row = (who, code, note) => `<li><div class="t"><b>${esc(who)}</b>${note ? `<div class="code">${esc(note)}</div>` : ''}</div><span class="code" style="font-size:15px;color:var(--ink)">${esc(code)}</span></li>`;
  return `<div class="grid g2"><div class="card"><h2>Sign-in codes</h2><p class="lede">Each device opens <b>${esc(location.origin)}</b> and signs in with its code. One device per team.</p>
    <ul class="board">${S.teams.map((t) => row(t.name, t.code, 'Team device')).join('')}</ul></div>
    <div class="stack"><div class="card"><h3>Staff</h3><ul class="board">
      ${row('Facilitator', S.auth.facilitator, 'This device')}${row('Review panel', S.auth.panel, 'Approves challenges')}${row('Projector', S.auth.projector, 'Big screen, read only')}
      ${S.judges.map((j) => row(j.name, j.code, 'Scores pitches')).join('')}</ul></div></div></div>`;
}

/* ---------- team ---------- */
function chForm(prefix, c, heading, required) {
  c = c || {};
  return `<fieldset><legend>${heading}</legend><div class="fgrid">
   <label class="f full">Challenge title <em>One line the panel can read at a glance</em><input type="text" id="${prefix}-title" maxlength="160" value="${esc(c.title)}" ${required ? 'required' : ''}></label>
   <label class="f">Category<select id="${prefix}-cat">${CATS.map((x) => `<option ${c.cat === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
   <label class="f">Customer journey stage<select id="${prefix}-stage">${STAGES.map((x) => `<option ${c.stage === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
   <label class="f full">What goes wrong today?<textarea id="${prefix}-problem" maxlength="1200">${esc(c.problem)}</textarea></label>
   <label class="f">Who does it affect?<input type="text" id="${prefix}-affects" maxlength="160" value="${esc(c.affects)}"></label>
   <label class="f">Why it matters <em>complaints, delays, lost sales</em><input type="text" id="${prefix}-why" maxlength="1200" value="${esc(c.why)}"></label>
  </div></fieldset>`;
}
function readForm(prefix) {
  const g = (k) => document.getElementById(prefix + '-' + k)?.value.trim() || '';
  return { title: g('title'), cat: g('cat'), stage: g('stage'), problem: g('problem'), affects: g('affects'), why: g('why') };
}
function titleBoard(t) {
  const items = S.teams.filter((o) => o.primary).map((o) => { const a = act(o); return `<li><div class="t"><div>${esc(a.title)}</div><span class="code">${esc(o.name)}${o === t ? ' · you' : ''}</span></div>${pill(a.status === 'standby' ? 'pending' : a.status)}</li>`; }).join('');
  return `<div class="card"><h3>Challenges already submitted</h3><p class="lede">Titles only. Pick something different to avoid a duplicate. If two teams submit the same challenge, the earlier one keeps it.</p><ul class="board">${items || '<li>No submissions yet.</li>'}</ul></div>`;
}
function vTeam() {
  const t = team(S, ME.teamId);
  const head = `<div class="card row between"><div><div class="eyebrow">This device is signed in as</div><h3>${esc(t.name)} <span class="code">${esc(t.code || '')}</span></h3></div></div>`;
  let main = '';
  if (S.phase === 's5') {
    const st = teamState(t);
    if (st === 'new') {
      main = `<form class="card stack" data-form="submit-new"><div><h2>Submit your challenge</h2><p class="lede">What part of the customer journey should be fixed? It could be a process, a digital gap, a sales problem or anything customers struggle with. Add a backup in case the panel finds a duplicate.</p></div>
        ${chForm('p', null, 'Primary challenge', true)}${chForm('b', null, 'Backup challenge', false)}
        <div class="row"><button class="btn primary" type="submit">Submit to panel</button></div></form>`;
    } else if (st === 'refine') {
      const a = act(t);
      main = `<form class="card stack" data-form="resubmit"><div><h2>The panel asked you to refine</h2></div>
        <div class="note"><b>Panel comment:</b> ${esc(a.note)}</div>
        ${chForm('p', a, t.active === 'primary' ? 'Primary challenge' : 'Backup challenge', true)}
        <div class="row"><button class="btn primary" type="submit">Resubmit</button></div></form>`;
    } else if (st === 'again') {
      const a = act(t);
      main = `<form class="card stack" data-form="again"><div><h2>Submit a new challenge</h2></div>
        <div class="note bad">${a.status === 'duplicate' ? 'Your challenge was marked as a duplicate.' : 'Your challenge was not accepted.'} ${esc(a.note)} You have no backup left, so please submit a new one.</div>
        ${chForm('p', null, 'New challenge', true)}
        <div class="row"><button class="btn primary" type="submit">Submit to panel</button></div></form>`;
    } else {
      const a = act(t); const used = t.active === 'backup';
      main = `<div class="card stack"><div class="row between"><h2>Your challenge</h2>${pill(a.status)}</div>
        ${used && t.primary ? `<div class="note info">Your primary challenge was ${t.primary.status === 'duplicate' ? 'a duplicate' : 'not accepted'}${t.primary.note ? ` (${esc(t.primary.note)})` : ''}. Your backup is now with the panel.</div>` : ''}
        <h3>${esc(a.title)}</h3>
        <dl class="kv"><dt>Category</dt><dd>${esc(a.cat)}</dd><dt>Journey stage</dt><dd>${esc(a.stage)}</dd><dt>Today</dt><dd>${esc(a.problem)}</dd><dt>Affects</dt><dd>${esc(a.affects)}</dd><dt>Why it matters</dt><dd>${esc(a.why)}</dd><dt>Submitted</dt><dd>${esc(a.ts)}</dd></dl>
        ${!used && t.backup ? `<hr class="soft"><div class="row between"><span><span class="eyebrow">Backup</span> ${esc(t.backup.title)}</span>${pill('standby')}</div>` : ''}
        <p class="lede" style="margin:0">${a.status === 'approved' ? 'Approved. This will be your challenge in Session 10.' : 'The panel will review this shortly. This screen updates on its own.'}</p></div>`;
    }
    return `${head}<div class="grid g2" style="margin-top:16px">${main}${titleBoard(t)}</div>`;
  }
  if (S.phase === 'locked') {
    return `${head}<div class="card" style="margin-top:16px"><h2>Your challenge is locked in</h2><p class="lede">See you in Session 10. Your canvas will open with this challenge already filled in.</p><h3>${esc(act(t).title)}</h3></div>`;
  }
  const c = canvasOf(S, t.id); const a = act(t); const ro = S.phase !== 'sprint';
  return `${head}<form class="card stack" style="margin-top:16px" data-form="canvas">
    <div class="row between"><div><h2>Proposal canvas</h2><p class="lede">This becomes your slide during the 3-minute pitch. Keep each box short enough to say in under a minute.</p></div>
    ${S.phase === 'sprint' ? `<div><div class="eyebrow">Sprint time left</div><div class="timer-sm" data-timer="sprint">${fmt(remaining(S.sprint, now()))}</div></div>` : '<span class="pill p-standby">Locked for pitching</span>'}</div>
    <div class="fgrid">
      <div class="full note info"><b>Challenge (from Session 05):</b> ${esc(a.title)} <span class="tag">${esc(a.cat)}</span></div>
      <label class="f full">Pitch title<input type="text" id="c-title" maxlength="160" value="${esc(c.title)}" ${ro ? 'disabled' : ''}></label>
      <label class="f full">Proposed approach <em>What will you do?</em><textarea id="c-approach" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(c.approach)}</textarea></label>
      <label class="f full">Implementation <em>Steps, owners, timeline, cost</em><textarea id="c-impl" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(c.impl)}</textarea></label>
      <label class="f full">Expected benefits <em>For customers and for the bank, with numbers if you have them</em><textarea id="c-benefits" maxlength="1200" ${ro ? 'disabled' : ''}>${esc(c.benefits)}</textarea></label>
    </div>
    ${ro ? '' : `<div class="row"><button class="btn primary" type="submit">Save canvas</button><span class="code">${c.saved ? 'Saved ' + esc(c.saved) : 'Not saved yet'}${Object.keys(drafts).some((k) => k.startsWith('c-')) ? ' · unsaved changes' : ''}</span></div>`}
  </form>`;
}

/* ---------- panel ---------- */
function vPanel() {
  const order = { pending: 0, refine: 1, none: 2, approved: 3 };
  const list = [...S.teams].sort((a, b) => (order[curStatus(a)] ?? 2) - (order[curStatus(b)] ?? 2));
  const editable = S.phase === 's5'; const n = N();
  const cards = list.map((t) => {
    const st = teamState(t);
    if (st === 'new') return `<div class="qcard is-none"><div class="row between"><h3>${esc(t.name)}</h3>${pill('none')}</div><p class="lede" style="margin:0">Nothing submitted yet.</p></div>`;
    const a = act(t); const sim = a.status === 'pending' ? similarTo(S, t) : null;
    return `<div class="qcard is-${a.status === 'approved' ? 'approved' : a.status === 'refine' ? 'refine' : a.status === 'pending' ? 'pending' : 'none'}">
      <div class="row between"><div><span class="eyebrow">${esc(t.name)} · ${t.active === 'backup' ? 'backup' : 'primary'} · ${esc(a.ts)}</span><h3>${esc(a.title)}</h3></div>${pill(a.status)}</div>
      <div class="row"><span class="tag">${esc(a.cat)}</span><span class="tag">${esc(a.stage)}</span></div>
      <dl class="kv"><dt>Today</dt><dd>${esc(a.problem)}</dd><dt>Affects</dt><dd>${esc(a.affects)}</dd><dt>Why it matters</dt><dd>${esc(a.why)}</dd></dl>
      ${sim ? `<div class="note bad"><b>Possible duplicate</b> of ${esc(sim.team.name)}: “${esc(act(sim.team).title)}”</div>` : ''}
      ${a.status === 'refine' ? `<div class="note">Waiting for the team to refine: ${esc(a.note)}</div>` : ''}
      ${editable && a.status === 'pending' ? `
        <div class="row"><button class="btn ok small" data-act="approve" data-id="${t.id}">Approve</button>
        <select id="dup-${t.id}" aria-label="Duplicate of" style="width:auto">${S.teams.filter((o) => o !== t && act(o)).map((o) => `<option value="${o.id}" ${sim && sim.team === o ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
        <button class="btn bad small" data-act="dup" data-id="${t.id}">Mark duplicate</button></div>
        <label class="f">Comment to the team <em>needed to send back or reject</em><input type="text" id="note-${t.id}" maxlength="300" placeholder="e.g. Narrow it to one product or one lounge process"></label>
        <div class="row"><button class="btn warn small" data-act="refine" data-id="${t.id}">Send back to refine</button><button class="btn bad small" data-act="reject" data-id="${t.id}">Reject</button></div>` : ''}
      ${editable && a.status === 'approved' ? `<div><button class="link" data-act="undo" data-id="${t.id}">Undo approval</button></div>` : ''}
    </div>`;
  }).join('');
  return `<div class="grid g2"><div class="stack"><div class="card"><h2>Review queue</h2><p class="lede">Approve one distinct challenge per team. Marking a duplicate or rejecting moves the team to its backup automatically.</p>
    <div class="stats"><div class="stat"><b>${approvedCount(S)}/${n}</b><span>Approved</span></div><div class="stat"><b>${S.teams.filter((t) => act(t)?.status === 'pending').length}</b><span>To review</span></div></div>
    ${!editable ? '<p class="note info" style="margin-top:12px">Challenges are locked. The queue is read-only.</p>' : ''}</div>${cards}</div>
    <div class="stack"><div class="card"><h3>What makes a good challenge</h3><ul style="margin:0;padding-left:18px;color:var(--muted)">
      <li>A real customer or staff pain point seen in the lounges or on digital channels</li><li>Specific enough to solve in a 3-minute proposal</li><li>Can be improved by the retail team, not only by IT or policy change</li><li>Different from every other approved challenge</li></ul></div>
      <div class="card"><h3>Approved so far</h3><ul class="board">${S.teams.filter((t) => act(t)?.status === 'approved').map((t) => `<li><div class="t">${esc(act(t).title)}<div class="code">${esc(t.name)}</div></div></li>`).join('') || '<li>None yet.</li>'}</ul></div></div></div>`;
}

/* ---------- judge ---------- */
function vJudge() {
  const j = ME.judge;
  const head = `<div class="card row between"><div><div class="eyebrow">Scoring as</div><h3>${esc(S.judges[j].name)}</h3></div></div>`;
  if (!['pitch', 'results'].includes(S.phase)) {
    return head + `<div class="card" style="margin-top:16px"><h2>Scoring opens when pitches start</h2><p class="lede">You will score each team on five criteria from 1 to 5 as they present.</p>
    <div class="tbl"><table class="t"><thead><tr><th>Criterion</th><th style="text-align:right">Weight</th></tr></thead><tbody>${CRIT.map((c) => `<tr><td>${c.k}</td><td class="n">${c.w}%</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  const mine = S.scores[j] || {};
  const cards = S.teams.map((t, i) => {
    const s = mine[t.id] || { c: [0, 0, 0, 0, 0], submitted: false };
    const done = s.c.every((v) => v > 0); const onStage = S.phase === 'pitch' && i === S.pitchIdx;
    return `<div class="card stack" ${onStage ? 'style="border-color:var(--accent)"' : ''}>
      <div class="row between"><div><span class="eyebrow">Pitch ${i + 1} · ${esc(t.name)}</span><h3>${esc(canvasOf(S, t.id).title || act(t)?.title)}</h3></div>
      ${onStage ? '<span class="now-badge">On stage</span>' : s.submitted ? '<span class="pill p-approved">Submitted</span>' : ''}</div>
      <div class="crit">${CRIT.map((c, ci) => `<span>${c.k} <span class="code">${c.w}%</span></span><div class="dots">${[1, 2, 3, 4, 5].map((v) => `<button data-act="score" data-team="${t.id}" data-c="${ci}" data-v="${v}" aria-pressed="${s.c[ci] === v}" ${s.submitted ? 'disabled' : ''} aria-label="${c.k} ${v}">${v}</button>`).join('')}</div>`).join('')}</div>
      <div class="row between"><span class="code">Score: ${done ? judgeTotal(s.c).toFixed(0) + ' / 100' : '—'}</span>
      ${s.submitted ? '<span class="code">Locked</span>' : `<button class="btn primary small" data-act="submit-score" data-team="${t.id}" ${done ? '' : 'disabled'}>Submit score</button>`}</div></div>`;
  }).join('');
  return head + `<div class="grid" style="margin-top:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))">${cards}</div>`;
}

/* ---------- projector ---------- */
function vProjector() {
  let inner = ''; const n = N();
  const fs = ME.role === 'projector' ? `<button class="btn small" data-act="fullscreen">Full screen</button>` : '';
  if (S.phase === 's5') {
    inner = `<div class="row between"><div><div class="eyebrow">Session 05 · Reimagine the Customer Journey</div><h2>Challenge submissions</h2></div>${fs}</div>
     <div class="ptiles">${S.teams.map((t) => { const st = curStatus(t); const a = act(t);
      return `<div class="ptile ${st === 'approved' ? 'ok' : ''}"><span class="tm">${esc(t.name)}</span><span class="ch ${a && st !== 'none' ? '' : 'empty'}">${a && st !== 'none' ? esc(a.title) : 'Waiting for submission'}</span><span class="st">${statusLabel[st]}</span></div>`; }).join('')}</div>
     <div class="eyebrow">${approvedCount(S)} of ${n} approved</div>`;
  } else if (S.phase === 'locked') {
    inner = `<div class="row between"><div><div class="eyebrow">Locked for Session 10</div><h2>This afternoon's ${n} challenges</h2></div>${fs}</div>
     <div class="ptiles">${S.teams.map((t) => `<div class="ptile ok"><span class="tm">${esc(t.name)}</span><span class="ch">${esc(act(t).title)}</span><span class="st">${esc(act(t).cat)}</span></div>`).join('')}</div>`;
  } else if (S.phase === 'sprint') {
    const r = remaining(S.sprint, now());
    inner = `<div class="row between"><div><div class="eyebrow">Session 10 · Ideation sprint</div><h2>Build your proposal</h2></div>${fs}</div>
     <div class="bigtimer ${r === 0 ? 'done' : r <= 60 ? 'red' : r <= 300 ? 'amber' : ''}" data-timer="sprint" data-big="1">${fmt(r)}</div>
     <div class="ptiles">${S.teams.map((t) => `<div class="ptile"><span class="tm">${esc(t.name)}</span><span class="ch" style="font-size:19px">${esc(act(t).title)}</span></div>`).join('')}</div>`;
  } else if (S.phase === 'pitch') {
    const t = S.teams[S.pitchIdx]; const c = canvasOf(S, t.id); const r = remaining(S.pitchT, now());
    const box = (h, v) => `<div class="pbox"><h4>${h}</h4><p>${v ? esc(v) : '<span style="opacity:.5">Not filled in</span>'}</p></div>`;
    inner = `<div class="row between"><div class="eyebrow">Pitch ${S.pitchIdx + 1} of ${n} · ${esc(t.name)}</div>${fs}</div>
     <div class="pitch"><div class="stack"><h2>${esc(c.title || act(t).title)}</h2>
       ${box('Challenge', act(t).title)}${box('Proposed approach', c.approach)}${box('Implementation', c.impl)}${box('Expected benefits', c.benefits)}</div>
       <div class="stack"><div class="eyebrow">Time remaining</div><div class="bigtimer ${r === 0 ? 'done' : r <= 30 ? 'red' : r <= 60 ? 'amber' : ''}" data-timer="pitch" data-big="1">${fmt(r)}</div></div></div>`;
  } else {
    const res = results(S);
    const catBest = (i) => res.slice().sort((a, b) => b.critAvg[i] - a.critAvg[i])[0];
    inner = `<div class="row between"><div><div class="eyebrow">Session 10 · Results</div><h2>${esc(S.event.title)}</h2></div>${fs}</div>
     <ol class="lb">${res.map((r, i) => { const shown = i >= n - S.reveal; return `<li class="${shown && i === 0 ? 'first' : ''} ${shown ? '' : 'hid'}"><span class="rk">${i + 1}</span>
      <div><div class="nm">${shown ? esc(r.t.name) : '· · ·'}</div><div class="sub">${shown ? esc(canvasOf(S, r.t.id).title || act(r.t).title) : ''}</div></div><span class="sc">${shown ? r.avg.toFixed(1) : ''}</span></li>`; }).join('')}</ol>
     ${S.reveal >= n && res[0]?.n ? `<div class="ptiles"><div class="ptile"><span class="tm">Most practical</span><span class="ch">${esc(catBest(0).t.name)}</span></div><div class="ptile"><span class="tm">Best customer impact</span><span class="ch">${esc(catBest(1).t.name)}</span></div><div class="ptile"><span class="tm">Most innovative</span><span class="ch">${esc(catBest(3).t.name)}</span></div></div>` : ''}`;
  }
  return `<div class="proj">${inner}</div>`;
}

/* ---------- render (keeps unsaved input and focus across live updates) ---------- */
function render() {
  const f = document.activeElement; const fid = f?.id; let sel = null;
  try { if (fid && 'selectionStart' in f) sel = [f.selectionStart, f.selectionEnd]; } catch {}
  renderChrome();
  if (!S) { $('#app').innerHTML = vLogin(); $('#login-code')?.focus(); return; }
  const v = { facilitator: vFacilitator, team: vTeam, panel: vPanel, judge: vJudge, projector: vProjector }[ME.role];
  $('#app').innerHTML = v();
  for (const [id, val] of Object.entries(drafts)) { const el = document.getElementById(id); if (el && !el.disabled) el.value = val; }
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} } }
}
function tick() {
  if (!S) return;
  document.querySelectorAll('[data-timer]').forEach((el) => {
    const x = el.dataset.timer === 'sprint' ? S.sprint : S.pitchT; const r = remaining(x, now());
    el.textContent = fmt(r);
    el.classList.remove('amber', 'red', 'done');
    const isP = el.dataset.timer === 'pitch';
    if (el.dataset.big && r === 0) el.classList.add('done');
    else if (r <= (isP ? 30 : 60)) el.classList.add('red');
    else if (r <= (isP ? 60 : 300)) el.classList.add('amber');
  });
}
setInterval(tick, 250);

/* ---------- export ---------- */
function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Rank', 'Team', 'Challenge', 'Category', 'Journey stage', 'Pitch title', 'Approach', 'Implementation', 'Benefits', 'Score', 'Judges', ...CRIT.map((c) => c.k + ' (avg)')].map(q).join(',')];
  results(S).forEach((r, i) => { const a = act(r.t) || {}; const c = canvasOf(S, r.t.id);
    lines.push([i + 1, r.t.name, a.title, a.cat, a.stage, c.title, c.approach, c.impl, c.benefits, r.avg.toFixed(1), r.n, ...r.critAvg.map((x) => x.toFixed(2))].map(q).join(',')); });
  lines.push('', q('Other submitted challenges (not used)'), ['Team', 'Challenge', 'Category', 'Status', 'Panel note'].map(q).join(','));
  S.teams.forEach((t) => ['primary', 'backup'].forEach((k) => { const c = t[k]; if (c && c !== act(t)) lines.push([t.name, c.title, c.cat, statusLabel[c.status], c.note].map(q).join(',')); }));
  S.history.forEach((h) => lines.push([h.team, h.c.title, h.c.cat, statusLabel[h.c.status], h.c.note].map(q).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'innovation-challenge-results.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- events ---------- */
const clearDrafts = (prefix) => Object.keys(drafts).forEach((k) => { if (k.startsWith(prefix)) delete drafts[k]; });
document.addEventListener('input', (e) => { if (e.target.id && e.target.id !== 'login-code' && e.target.matches('input,textarea,select')) drafts[e.target.id] = e.target.value; });
document.addEventListener('change', (e) => { if (e.target.id && e.target.matches('select')) drafts[e.target.id] = e.target.value; });

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  const note = () => document.getElementById('note-' + id)?.value.trim() || '';
  switch (a) {
    case 'signout': if (confirm('Sign this device out?')) signOut(); return;
    case 'view': VIEW = id; render(); return;
    case 'export': exportCSV(); return;
    case 'fullscreen': document.documentElement.requestFullscreen?.().catch(() => {}); return;
    case 'reset-round': if (!confirm('Reset the whole event? This clears every submission, canvas and score on every device.')) return; break;
    case 'demo-s5': case 'demo-canvas': case 'demo-scores': if (!confirm('Add rehearsal sample data to the live event?')) return; break;
    case 'dup': if (await send({ type: 'dup', id, of: document.getElementById('dup-' + id)?.value })) { clearDrafts('note-' + id); clearDrafts('dup-' + id); render(); } return;
    case 'refine': case 'reject': if (await send({ type: a, id, note: note() })) { clearDrafts('note-' + id); render(); } return;
    case 'score': case 'submit-score': send({ type: a, team: b.dataset.team, c: b.dataset.c, v: b.dataset.v }); return;
  }
  send({ type: a, id });
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.dataset.form;
  if (f === 'login') return signIn($('#login-code').value);
  if (f === 'canvas') {
    const g = (k) => document.getElementById('c-' + k).value;
    if (await send({ type: 'canvas', c: { title: g('title'), approach: g('approach'), impl: g('impl'), benefits: g('benefits') } })) { clearDrafts('c-'); render(); }
    return;
  }
  const p = readForm('p'); if (!p.title) return toast('Add a challenge title.');
  const ok = await send(f === 'submit-new' ? { type: f, p, b: readForm('b') } : { type: f, p });
  if (ok) { clearDrafts('p-'); clearDrafts('b-'); render(); }
});

// Save the canvas with Ctrl/Cmd+S during the sprint.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { const form = document.querySelector('form[data-form="canvas"]'); if (form) { e.preventDefault(); form.requestSubmit(); } }
});
window.addEventListener('beforeunload', (e) => { if (Object.keys(drafts).some((k) => /^(c|p|b)-/.test(k))) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- boot ---------- */
const params = new URLSearchParams(location.search);
const urlCode = params.get('code');
if (urlCode) history.replaceState(null, '', location.pathname);
CODE = urlCode || store.get('ric-code');
if (CODE) signIn(CODE); else render();
