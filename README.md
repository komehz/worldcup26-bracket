# World Cup 26

A live, rotatable 3D knockout bracket for the 2026 World Cup. Five concentric
rings of national flags rise as a stepped cone toward a gold trophy, and teams
advance one ring inward along gold beams as results come in. The whole stack
spins about a single vertical axis. It ships in light mode (with a dark "stadium
night" theme), works on mobile, and reads its entire state from one JSON file.

![World Cup 26 knockout bracket](assets/preview.png)

## Features

- Five ring radial bracket: Round of 32 on the rim through the Final at the
  core, opponents grouped as tight pairs, each tie centered between its feeders.
- Live and advancing: live matches pulse gold; when a match finishes the winner
  flies inward along a drawn beam and the loser desaturates.
- Data driven: the renderer hardcodes nothing. It renders whatever
  `public/bracket.json` says and re-renders when it changes.
- Light and dark themes (light by default, choice remembered) and a responsive
  mobile layout.
- National flags only, no FIFA marks. The identity is typography and the flags.

## Built with

- [Three.js](https://threejs.org/) (WebGL) for the 3D scene, loaded from a CDN
  via an import map, so there is no build step.
- Vanilla JavaScript (ES modules): no framework, no bundler.
- Node.js for the zero dependency dev server and the data update script.
- [Inter](https://rsms.me/inter/) and IBM Plex Mono (Google Fonts). Flags from
  [flagcdn.com](https://flagcdn.com).

## Run it

```bash
npm start    # serves at http://localhost:5173
```

It must be served over HTTP (ES modules and `fetch` are blocked on `file://`).
Any static server works; `python -m http.server` is a fine substitute.

## Live data

`public/bracket.json` holds the whole tournament. `update-bracket.mjs` rebuilds
it from [football-data.org](https://www.football-data.org), whose free tier
covers the FIFA World Cup. It pulls every knockout fixture, constructs the rounds
(teams, scores, status, kickoffs), maps each nation to its flag, and derives the
advancement tree from who actually went through.

```bash
# rebuild once from the live feed
FOOTBALL_DATA_TOKEN=your_token npm run update-bracket

# keep it fresh on a loop (every 5 min here)
FOOTBALL_DATA_TOKEN=your_token WATCH=300 npm run update-bracket
```

To save requests, it only calls the provider when a match is live or about to
kick off. The browser fetches `bracket.json` on its own: when the dev server is
running it gets an instant push (server sent events), and on a static host it
falls back to lightweight conditional polling.

### Try it with no token

```bash
npm start      # terminal 1
npm run demo   # terminal 2: simulates matches kicking off, scoring, finishing
```

`npm run demo` drives the bracket with no API at all. Reset anytime with
`git checkout public/bracket.json`.

## Deploy on Vercel (free, with live data)

The site is static, so a plain Vercel import works (framework preset: Other;
`vercel.json` sets the output directory to the repo root). Vercel cannot run the
always on server or write files at runtime, so live data comes from a scheduled
GitHub Action (`.github/workflows/update-bracket.yml`):

1. Push to GitHub and import the repo into Vercel (it auto-deploys on push).
2. In the repo: Settings, Secrets and variables, Actions, add
   `FOOTBALL_DATA_TOKEN`.

The Action rebuilds `bracket.json` on a schedule, commits only when something
changed, and the push triggers a Vercel redeploy. New scores appear within a few
minutes. It disables itself the day after the final.

## Project layout

```
index.html            import map and chrome
src/scene.js          3D rings, lighting, trophy, interaction, animations
src/bracket.js        live push (SSE) plus conditional polling of bracket.json
src/ui.js             header, round rail, side panel, theme toggle
src/main.js           wiring
src/flags.js          team code to flag mapping
public/bracket.json   the single source of truth
serve.mjs             dev server (ETag/304 plus SSE push)
update-bracket.mjs    builds the bracket from football-data.org (or a demo)
```
