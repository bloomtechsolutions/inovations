# Retail Innovation Challenge

A live, multi-device app for running the Retail Innovation Challenge (BML Retail Training, Sessions 05 & 10).
Each role signs in on its own device, and every screen stays in sync in real time.

| Role | Device | What it does |
|---|---|---|
| **Facilitator** | Laptop | Moves the whole room between stages, runs the sprint and pitch timers, reveals results, downloads a CSV, sees every sign-in code |
| **Team** | One per team | Submits a primary + backup challenge, refines or replaces it if the panel asks, fills in the proposal canvas during the sprint |
| **Review panel** | Laptop/tablet | Approves challenges, flags duplicates (with automatic similar-title detection), sends back to refine, rejects |
| **Judge** | Phone/tablet | Scores each pitch 1–5 on five weighted criteria and locks the score |
| **Projector** | Big screen | Read-only: submission board, locked challenges, big countdown, pitch canvas, results leaderboard |

Session flow: **Challenge submissions → Challenges locked → Ideation sprint (32 min) → Pitches (3 min each) → Results**.

## Run it

Needs Node.js 18 or newer. There are no dependencies to install.

```bash
npm start
```

The server prints every sign-in code on start. Open `http://<server-ip>:3000` on each device and enter its code.
The facilitator's **Sign-in codes** tab lists them all, ready to hand out. A device can also sign in straight from a link such as `http://<server-ip>:3000/?code=ADD-4SMN`.

### Settings

- `config.json` holds the event title, the eyebrow line, the time zone used for timestamps, and the team and judge names. Edit it before the first start; after that, the event lives in `data/state.json`. Delete that file to start over with new codes.
- Environment variables:
  - `PORT` (default `3000`) and `HOST` (default `0.0.0.0`)
  - `DATA_DIR`: where `state.json` is saved (default `./data`)
  - `FACILITATOR_CODE`, `PANEL_CODE`, `PROJECTOR_CODE`: fixed codes instead of generated ones
  - `SAMPLE_TOOLS=off` hides the facilitator's rehearsal buttons (sample submissions, canvases and scores)

### Rehearsing

The facilitator screen has rehearsal buttons at each stage. They fill in sample submissions, canvases or judge scores so you can click through the whole session. **Reset event** clears everything and keeps the sign-in codes.

## How it works

- `server.js` is a plain Node HTTP server. Clients receive state over Server-Sent Events and send actions with `POST /api/action`. Every change is saved to `data/state.json`, so a restart picks up where it left off.
- `shared/logic.js` holds the rules: who may do what, at which stage. The server runs it as the only source of truth, and the browser imports the same file for its views. Each device receives only what it is allowed to see: teams never get scores or other teams' codes, and judges see only their own scores.
- `public/` is the client: vanilla JS, no build step. Unsaved typing survives live updates from other devices.
- Timers run on the server clock, so every screen shows the same countdown.

## Tests

```bash
npm test
```
