# World Cup 26 — 3D Knockout Bracket

A live, rotatable 3D knockout bracket for the 2026 World Cup. Five concentric
rings of national flags rise as a stepped cone toward a gold trophy; teams
advance one ring inward along gold beams as results come in. The whole stack
spins about a single vertical axis. Ships in light mode (with a dark "stadium
night" theme), works on mobile, and reads its entire state from one JSON file.

![World Cup 26 knockout bracket](assets/preview.png)

## Features

- **Five-ring radial bracket** — Round of 32 on the rim to the Final at the
  core, opponents grouped as tight pairs, each tie centered between its feeders.
- **Live & advancing** — live matches pulse gold; when a match goes final the
  winner's card flies inward along a drawn beam and the loser desaturates.
- **Data-driven** — the renderer hardcodes nothing; it renders whatever
  `public/bracket.json` says and re-renders when it changes.
- **Light / dark themes** (light by default, choice remembered) and a
  **responsive** mobile layout.
- **National flags only**, no FIFA marks — identity is typography and the flags.

## Built with

- **[Three.js](https://threejs.org/)** (WebGL) for the 3D scene — loaded from a
  CDN via an import map, so there's **no build step**.
- **Vanilla JavaScript** (ES modules) — no framework, no bundler.
- **Node.js** for the zero-dependency dev server and the data-update script.
- **[Inter](https://rsms.me/inter/)** + **IBM Plex Mono** (Google Fonts);
  flags from **[flagcdn.com](https://flagcdn.com)**.

## Run it

```bash
npm start    # serves at http://localhost:5173
```

Must be served over HTTP (ES modules + `fetch` are blocked on `file://`). Any
static server works; `python -m http.server` is a fine substitute.

## Data & live updates

The browser only ever does `fetch('public/bracket.json')`, but efficiently:
adaptive cadence (faster while a match is live), conditional `ETag` requests
(unchanged polls return a bodyless `304`), and it pauses while the tab is hidden.

To keep the file fresh from a real provider, run the update job (key stays
server-side):

```bash
# one-off; resolves winners into the next round even with no key
npm run update-bracket
# self-rescheduling loop against a provider (e.g. API-FOOTBALL)
WATCH=30 API_FOOTBALL_KEY=… LEAGUE_ID=… SEASON=2026 npm run update-bracket
```

## Project layout

```
index.html            import map + chrome
src/scene.js          3D rings, lighting, trophy, interaction, animations
src/bracket.js        adaptive, conditional polling of bracket.json
src/ui.js             header, round rail, side panel, theme toggle
src/main.js           wiring
src/flags.js          FIFA code → flag mapping
public/bracket.json   the single source of truth
serve.mjs             dev server (with ETag/304)
update-bracket.mjs    fetches a provider + resolves advancement
```

## Notes

- Bracket topology follows the official radial draw; each match's `feedsInto`
  encodes the tree.
- For social link previews after deploying, set an absolute `og:image` URL (and
  `og:url`) in `index.html`.
