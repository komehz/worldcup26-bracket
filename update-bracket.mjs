// Rewrites public/bracket.json. Two jobs:
//
//   1. (online)  Pull live fixtures from a provider and stamp scores/status
//                onto the matching matches. The API key stays here, server side
//                — the browser never sees it and only ever reads bracket.json.
//   2. (always)  Resolve advancement: push every decided winner into the slot
//                its `feedsInto` points at, so the inner rounds seed themselves.
//
// Run it on a schedule (cron / serverless) during match windows, or by hand:
//
//   API_FOOTBALL_KEY=xxx LEAGUE_ID=1 SEASON=2026 npm run update-bracket
//   npm run update-bracket          # offline: just re-resolves advancement
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("./public/bracket.json", import.meta.url));

// Provider team name -> FIFA code. Extend as needed for your data source.
const ALIAS = {
  Canada: "CAN", "South Africa": "RSA", Paraguay: "PAR", Germany: "GER",
  Morocco: "MAR", Netherlands: "NED", Brazil: "BRA", Japan: "JPN",
  "Ivory Coast": "CIV", "Côte d'Ivoire": "CIV", Norway: "NOR", France: "FRA",
  Sweden: "SWE", Mexico: "MEX", Ecuador: "ECU", England: "ENG",
  "Congo DR": "COD", "DR Congo": "COD", Belgium: "BEL", Senegal: "SEN",
  USA: "USA", "United States": "USA", "Bosnia and Herzegovina": "BIH",
  Spain: "ESP", Austria: "AUT", Portugal: "POR", Croatia: "CRO",
  Switzerland: "SUI", Algeria: "ALG", Argentina: "ARG", "Cape Verde": "CPV",
  Australia: "AUS", Egypt: "EGY", Colombia: "COL", Ghana: "GHA",
};

function codeOf(name) {
  return ALIAS[name] || null;
}

// ---- 1. live fixtures (API-FOOTBALL shape; swap for your provider) ----------
async function fetchFixtures() {
  const key = process.env.API_FOOTBALL_KEY;
  const league = process.env.LEAGUE_ID;
  const season = process.env.SEASON || "2026";
  if (!key || !league) {
    console.log("• No API_FOOTBALL_KEY/LEAGUE_ID — skipping live fetch, resolving only.");
    return null;
  }
  const url = `https://v3.football.api-sports.io/fixtures?league=${league}&season=${season}`;
  const res = await fetch(url, { headers: { "x-apisports-key": key } });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
  const json = await res.json();
  return json.response || [];
}

function applyFixtures(data, fixtures) {
  if (!fixtures) return 0;
  // index our matches by an unordered pair of codes
  const byPair = new Map();
  for (const round of data.rounds) {
    for (const m of round.matches) {
      const a = m.teamA?.code, b = m.teamB?.code;
      if (a && b) byPair.set([a, b].sort().join("-"), m);
    }
  }
  let touched = 0;
  for (const fx of fixtures) {
    const home = codeOf(fx.teams?.home?.name);
    const away = codeOf(fx.teams?.away?.name);
    if (!home || !away) continue;
    const m = byPair.get([home, away].sort().join("-"));
    if (!m) continue;

    const homeIsA = m.teamA.code === home;
    const gh = fx.goals?.home ?? null;
    const ga = fx.goals?.away ?? null;
    m.scoreA = homeIsA ? gh : ga;
    m.scoreB = homeIsA ? ga : gh;

    const st = fx.fixture?.status?.short; // NS, 1H, HT, 2H, ET, P, FT, AET, PEN...
    if (["FT", "AET", "PEN"].includes(st)) {
      m.status = "final";
      const ph = fx.score?.penalty?.home ?? null;
      const pa = fx.score?.penalty?.away ?? null;
      m.penaltiesA = homeIsA ? ph : pa;
      m.penaltiesB = homeIsA ? pa : ph;
      const wHome = (gh + (ph || 0)) > (ga + (pa || 0));
      m.winner = wHome ? home : away;
    } else if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(st)) {
      m.status = "live";
    }
    touched++;
  }
  return touched;
}

// ---- 2. resolve advancement -------------------------------------------------
function resolveAdvancement(data) {
  const roundById = Object.fromEntries(data.rounds.map((r) => [r.id, r]));
  for (const round of data.rounds) {
    for (const m of round.matches) {
      if (m.status !== "final" || !m.winner || !m.feedsInto) continue;
      const winTeam = m.teamA?.code === m.winner ? m.teamA : m.teamB;
      const tgt = roundById[m.feedsInto.round];
      const tm = tgt?.matches.find((x) => x.id === m.feedsInto.match);
      if (!tm || !winTeam) continue;
      const slotKey = m.feedsInto.slot === "B" ? "teamB" : "teamA";
      tm[slotKey] = { name: winTeam.name, code: winTeam.code };
    }
  }
}

// Compare ignoring updated_at, so we only rewrite (and only bump the timestamp)
// when something real changed — that keeps the client's 304 fast-path working.
const fingerprint = (o) => {
  const c = JSON.parse(JSON.stringify(o));
  delete c.updated_at;
  return JSON.stringify(c);
};

async function main() {
  const before = await readFile(FILE, "utf8");
  const data = JSON.parse(before);
  const n = applyFixtures(data, await fetchFixtures());
  resolveAdvancement(data);

  if (fingerprint(JSON.parse(before)) === fingerprint(data)) {
    console.log("· no change");
    return false;
  }
  data.updated_at = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`✓ bracket.json updated — ${n} match(es) from provider, advancement resolved.`);
  return true;
}

// `WATCH=30 npm run update-bracket` keeps the feed fresh on a self-rescheduling
// loop (poll the provider every 30s); otherwise it runs once and exits.
const WATCH = Number(process.env.WATCH || 0);
if (WATCH > 0) {
  console.log(`watching — provider poll every ${WATCH}s (Ctrl+C to stop)`);
  const tick = async () => {
    try { await main(); } catch (err) { console.error("update failed:", err.message); }
    setTimeout(tick, WATCH * 1000);
  };
  tick();
} else {
  main().catch((err) => {
    console.error("update-bracket failed:", err.message);
    process.exit(1);
  });
}
