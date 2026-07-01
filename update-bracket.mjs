// Rewrites public/bracket.json from football-data.org (free tier covers the
// FIFA World Cup). It BUILDS the whole knockout bracket from the live fixtures:
// teams, scores, status, kickoffs, and a feedsInto tree derived from who
// actually advanced. The browser just reads the file.
//
//   FOOTBALL_DATA_TOKEN=xxx npm run update-bracket     # one-off
//   FOOTBALL_DATA_TOKEN=xxx WATCH=300 npm run update-bracket   # loop
//   npm run demo                                       # offline simulation
//
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("./public/bracket.json", import.meta.url));
const API = "https://api.football-data.org/v4/competitions/WC/matches";

// football-data.org stage -> our round. Third-place match is intentionally left
// out so the innermost ring shows just the two finalists.
const STAGES = [
  { fd: "LAST_32", id: "R32", label: "Round of 32" },
  { fd: "LAST_16", id: "R16", label: "Round of 16" },
  { fd: "QUARTER_FINALS", id: "QF", label: "Quarterfinals" },
  { fd: "SEMI_FINALS", id: "SF", label: "Semifinals" },
  { fd: "FINAL", id: "FINAL", label: "Final" },
];

const teamOf = (t) =>
  t && t.name ? { name: t.name, code: t.tla || null } : { name: "To be decided", code: null, placeholder: true };

// football-data.org reports an in-play match as "LIVE" (and sometimes the more
// granular "IN_PLAY"/"PAUSED" at half-time). Treat all three as live, or a match
// in progress falls through to "scheduled" and never pulses on the bracket.
const statusOf = (s) =>
  ["LIVE", "IN_PLAY", "PAUSED"].includes(s) ? "live" : ["FINISHED", "AWARDED"].includes(s) ? "final" : "scheduled";

// Goals before any shootout, with penalties kept separate.
function scoreOf(score) {
  if (!score) return { a: null, b: null, pa: null, pb: null };
  if (score.penalties) {
    const rt = score.regularTime || score.fullTime || {};
    const et = score.extraTime || {};
    return {
      a: (rt.home ?? 0) + (et.home ?? 0),
      b: (rt.away ?? 0) + (et.away ?? 0),
      pa: score.penalties.home ?? null,
      pb: score.penalties.away ?? null,
    };
  }
  const ft = score.fullTime || {};
  return { a: ft.home ?? null, b: ft.away ?? null, pa: null, pb: null };
}

const fmtDay = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}`;
};
function windowOf(matches) {
  const ds = matches.map((m) => m.kickoff).filter(Boolean).sort();
  if (!ds.length) return "";
  const a = fmtDay(ds[0]), b = fmtDay(ds[ds.length - 1]);
  return a === b ? a : `${a} to ${b}`;
}

async function fetchMatches(token) {
  const res = await fetch(API, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
  const json = await res.json();
  return json.matches || [];
}

// Turn one provider fixture into a displayed match, oriented so (teamA, teamB)
// line up with the given team objects. For the Round of 32 those are just the
// provider's home/away; for inner rounds they are the two feeder winners, and
// the fixture (found by matching both teams) supplies score/status/kickoff.
function makeMatch(id, A, B, pm) {
  let status = "scheduled", winner = null, kickoff = null;
  let sc = { a: null, b: null, pa: null, pb: null };
  if (pm) {
    status = statusOf(pm.status);
    kickoff = pm.utcDate || null;
    const raw = scoreOf(pm.score);
    const homeIsA = pm.homeTeam?.tla === A.code;
    sc = homeIsA ? raw : { a: raw.b, b: raw.a, pa: raw.pb, pb: raw.pa };
    if (status === "final") {
      if (pm.score?.winner === "HOME_TEAM") winner = homeIsA ? A.code : B.code;
      else if (pm.score?.winner === "AWAY_TEAM") winner = homeIsA ? B.code : A.code;
    }
  }
  const show = status !== "scheduled";
  return {
    id,
    teamA: A, teamB: B,
    scoreA: show ? sc.a : null, scoreB: show ? sc.b : null,
    penaltiesA: sc.pa, penaltiesB: sc.pb,
    status, winner,
    kickoff,
    feedsInto: null,
  };
}

const placeholder = () => ({ name: "To be decided", code: null, placeholder: true });
const winnerTeamOf = (m) =>
  m && m.status === "final" && m.winner ? (m.teamA.code === m.winner ? m.teamA : m.teamB) : null;

function buildBracket(matches) {
  const byStage = {};
  for (const m of matches) (byStage[m.stage] ||= []).push(m);

  // Round of 32 comes straight from the provider, sorted by id.
  const r32 = (byStage[STAGES[0].fd] || [])
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((pm) => makeMatch(`m${pm.id}`, teamOf(pm.homeTeam), teamOf(pm.awayTeam), pm));
  const rounds = [{ id: STAGES[0].id, label: STAGES[0].label, window: windowOf(r32), matches: r32 }];

  // Every inner round is built structurally: matches sorted by id pair up as
  // (2k, 2k+1) bracket siblings feeding tie k of the next round (verified: this
  // reproduces every tie the provider has placed, lower id in slot A). We drop a
  // winner into its next-round slot the moment its match is final, even if the
  // opponent is still "to be decided" — the provider won't seed a tie until both
  // feeders finish, but the tree is known, so we don't wait. The next-round
  // fixture (for score/status/kickoff) is matched by its two teams once known.
  for (let s = 1; s < STAGES.length; s++) {
    const prev = rounds[s - 1].matches;
    const prov = byStage[STAGES[s].fd] || [];
    const ties = [];
    for (let k = 0; k < Math.floor(prev.length / 2); k++) {
      const a = prev[2 * k], b = prev[2 * k + 1];
      const A = winnerTeamOf(a) || placeholder();
      const B = winnerTeamOf(b) || placeholder();
      const id = `${STAGES[s].id}-${k}`;
      const pm =
        A.code && B.code
          ? prov.find((m) => {
              const h = m.homeTeam?.tla, x = m.awayTeam?.tla;
              return (h === A.code && x === B.code) || (h === B.code && x === A.code);
            })
          : null;
      ties.push(makeMatch(id, A, B, pm));
      if (a) a.feedsInto = { round: STAGES[s].id, match: id, slot: "A" };
      if (b) b.feedsInto = { round: STAGES[s].id, match: id, slot: "B" };
    }
    rounds.push({ id: STAGES[s].id, label: STAGES[s].label, window: windowOf(ties), matches: ties });
  }

  return { tournament: "World Cup 26", hosts: ["USA", "CAN", "MEX"], rounds };
}

// ---- offline demo simulator (no token) -------------------------------------
function simulateTick(data) {
  const matches = data.rounds.flatMap((r) => r.matches);
  const live = matches.filter((m) => m.status === "live");
  if (!live.length) {
    const next = matches
      .filter((m) => m.status === "scheduled" && m.teamA?.code && m.teamB?.code && m.kickoff)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];
    if (next) { next.status = "live"; next.scoreA = 0; next.scoreB = 0; }
    return;
  }
  for (const m of live) {
    const roll = Math.random();
    if (roll < 0.4) { Math.random() < 0.5 ? m.scoreA++ : m.scoreB++; }
    else if (roll < 0.72) {
      m.status = "final";
      if (m.scoreA === m.scoreB) {
        const win = Math.random() < 0.5;
        m.penaltiesA = win ? 4 : 3; m.penaltiesB = win ? 3 : 4;
        m.winner = win ? m.teamA.code : m.teamB.code;
      } else m.winner = m.scoreA > m.scoreB ? m.teamA.code : m.teamB.code;
    }
  }
}
function resolveAdvancement(data) {
  const byId = Object.fromEntries(data.rounds.map((r) => [r.id, r]));
  for (const round of data.rounds)
    for (const m of round.matches) {
      if (m.status !== "final" || !m.winner || !m.feedsInto) continue;
      const w = m.teamA?.code === m.winner ? m.teamA : m.teamB;
      const tm = byId[m.feedsInto.round]?.matches.find((x) => x.id === m.feedsInto.match);
      if (tm && w) tm[m.feedsInto.slot === "B" ? "teamB" : "teamA"] = { name: w.name, code: w.code };
    }
}

// Fetch on every run while the tournament is still going. We used to gate on a
// narrow "match window" around each kickoff (kickoff -20min to +150min), but
// GitHub throttles scheduled workflows to only a handful of runs a day, so runs
// kept landing outside those windows and finished matches were missed for good
// (once the window closed, that match never re-entered it). A full sync each
// run is cheap (the free tier allows ~10 req/min) and never misses a result.
// Once every match is final there is nothing left to pull, so we skip then.
function hasPendingMatches(data) {
  return data.rounds.flatMap((r) => r.matches).some((m) => m.status !== "final");
}

const fingerprint = (o) => {
  const c = JSON.parse(JSON.stringify(o));
  delete c.updated_at;
  return JSON.stringify(c);
};

async function main() {
  const before = await readFile(FILE, "utf8");
  const current = JSON.parse(before);
  let next;

  if (DEMO) {
    next = current;
    simulateTick(next);
    resolveAdvancement(next);
  } else {
    if (!hasPendingMatches(current)) { console.log("· every match is final — nothing left to update"); return false; }
    const token = process.env.FOOTBALL_DATA_TOKEN;
    if (!token) { console.log("· no FOOTBALL_DATA_TOKEN set — nothing to fetch"); return false; }
    next = buildBracket(await fetchMatches(token));
  }

  if (fingerprint(current) === fingerprint(next)) { console.log("· no change"); return false; }
  next.updated_at = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(next, null, 2) + "\n");
  console.log(DEMO ? "✓ bracket.json advanced (demo)" : "✓ bracket.json rebuilt from football-data.org");
  return true;
}

// CLI: --demo / DEMO=1 drives it locally; --watch=N / WATCH=N loops every N s.
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const optNum = (name, env) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return Number((a ? a.split("=")[1] : process.env[env]) || 0);
};
const DEMO = flag("demo") || Boolean(process.env.DEMO);
const WATCH = optNum("watch", "WATCH");

if (WATCH > 0) {
  console.log(`watching${DEMO ? " (demo)" : ""} — tick every ${WATCH}s (Ctrl+C to stop)`);
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
