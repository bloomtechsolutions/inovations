# Innovation Challenge · Bank of Maldives Refresher Training 2026

A live, multi-device app for running the Innovation Challenge. Each role signs in on its own device, and every screen stays in sync in real time.

| Role | Device | What it does |
|---|---|---|
| **Facilitator** | Laptop | Moves every screen between stages, runs the timers, renames teams, updates follow-ups, downloads a CSV, sees every sign-in code |
| **Team** (×6) | One per team, used by the team's representative | Enters the team's one challenge, then fills in the root cause (5 whys) and the solution, with optional AI hints and drafts |
| **Panelist** (×2) | Laptop/tablet/phone | Approves challenges (one approval is enough) or sends them back with a comment, then follows each pitch (with an optional AI briefing per team) and records follow-ups |
| **Projector** | Big screen | Read only: challenge board, locked challenges, big countdowns, pitch slide, follow-up board |

## Event flow

1. **Challenges.** Each team enters one challenge: an internal process or a customer pain point. The team then explains it to the panel. Either panelist can approve it or send it back with a comment. The big screen shows every challenge as it comes in.
2. **Locked.** When all six challenges are approved, they lock automatically and the big screen shows them.
3. **Root cause (5 min).** Teams ask "why?" up to five times and write down the root cause.
4. **Solution (20 min).** Teams design a solution for that root cause. Their work saves as they type. When a timer runs out, saving stops (after a 15-second grace period).
5. **Pitches (5 min each).** The big screen shows the team's challenge, root cause and solution with a countdown. Panelists see each team's full work on their device. After the last pitch, the panel chooses the best challenge and solution.
6. **Follow-up.** So the ideas keep moving after the event, the facilitator or a panelist gives each solution an owner, a pilot status (Not started, Planning, Piloting, Rolled out, On hold), a next step and a target date. Teams and the big screen see the board, and it is included in the CSV.

## AI assistant (optional)

When `GEMINI_API_KEY` is set, the app adds three helpers powered by Google Gemini (`gemini-3.8-flash` by default; set `GEMINI_MODEL` to use another model). A free API key from [Google AI Studio](https://aistudio.google.com/apikey) works, within Google's free-tier rate limits:

- **Root-cause hints** for teams: three probing questions, never the answer. Up to 3 per team.
- **Solution drafts** for teams, built on their root cause. Up to 2 per team. The team chooses whether to use one and can edit it.
- **Team briefings** for panelists and the facilitator during pitches and follow-up: a two-sentence summary, strengths, and questions to ask.

A failed request (including a free-tier rate limit) doesn't count against a team's limit. Without the key, the buttons don't appear. The code is in `shared/ai.js`.

The facilitator can pause any timer, add a minute, or move back a stage. Going back to Challenges unlocks them.

## Run it locally

Needs Node.js 22.

```bash
npm install
```

```bash
npm start
```

The server prints every sign-in code on start. Open `http://<server-ip>:3000` on each device and enter its code, or open a sign-in link such as `http://<server-ip>:3000/?code=1-7K2Q`. The facilitator's **Teams & codes** tab lists every code with a copy-link button.

### Settings

- `config.json` holds the event name, the team names, the panelist names and the time zone. Edit it before the event is first created. After that, the facilitator can rename teams in the app.
- Environment variables:
  - `PORT` (default `3000`) and `HOST` (default `0.0.0.0`)
  - `DATA_DIR`: where `state.json` is saved locally (default `./data`)
  - `FACILITATOR_CODE`, `PROJECTOR_CODE`: fixed codes instead of generated ones
  - `SAMPLE_TOOLS=off` hides the facilitator's rehearsal buttons

### Rehearsing

At each stage the facilitator screen has rehearsal buttons that fill in sample challenges, root causes or solutions, so you can click through the whole event. **Reset event** clears everything and keeps the sign-in codes. Before the real event, reset and set `SAMPLE_TOOLS=off`.

## Hosting on Vercel + Supabase

Serverless functions can't keep state, so on Vercel the event is stored in Supabase:

1. Apply the SQL in `supabase/migrations/` to the Supabase project. It creates a private `ric` schema plus four `ric_*` functions that only work when given the server key. Generate a random server key and store its SHA-256 hex in `ric.server_key`.
2. Set these environment variables on the Vercel project:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_KEY` | The project's publishable key |
| `RIC_SERVER_KEY` | The random server key from step 1 (mark as sensitive) |
| `FACILITATOR_CODE` | The facilitator's sign-in code. Every other code is on the facilitator's "Teams & codes" tab |
| `GEMINI_API_KEY` | Optional. Turns on the AI assistant (mark as sensitive) |
| `GEMINI_MODEL` | Optional. Gemini model ID, default `gemini-3.8-flash` |
| `GEMINI_FALLBACK_MODEL` | Optional. Model for the retry when the main one is slow. By default a Flash-Lite model is picked from the models the key can use |
| `GEMINI_THINKING` | Optional. Thinking level for the first try: `MINIMAL`, `LOW` (default), `MEDIUM` or `HIGH` |
| `EVENT_ID` | Optional. Defaults to `main`; change it to run a separate event in the same database |

## How it works

- `shared/logic.js` holds the rules: who may do what, at which stage. The server runs it as the only source of truth, and the browser imports the same file for its views. Each device receives only what it is allowed to see. Teams never see other teams' work before the pitches.
- `shared/api.js` is the HTTP API, used by both `server.js` (local) and `api/index.js` (Vercel). Devices check `GET /api/state` about once a second, and the server answers `204` when nothing has changed. Writes use compare-and-swap on a version number, so two devices acting at the same moment never lose a change.
- `public/` is the client: vanilla JS with no build step. Unsaved typing survives live updates from other devices.
- Timers run on the server clock, so every screen shows the same countdown.

## Tests

```bash
npm test
```
