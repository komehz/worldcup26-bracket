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

const statusOf = (s) =>
  ["IN_PLAY", "PAUSED"].includes(s) ? "live" : ["FINISHED", "AWARDED"].includes(s) ? "final" : "scheduled";

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

function buildBracket(matches) {
  const byStage = {};
  for (const m of matches) (byStage[m.stage] ||= []).push(m);

  const rounds = STAGES.map((st) => {
    const list = (byStage[st.fd] || []).slice().sort((a, b) => a.id - b.id);
    const built = list.map((m) => {
      const A = teamOf(m.homeTeam), B = teamOf(m.awayTeam);
      const status = statusOf(m.status);
      const sc = scoreOf(m.score);
      let winner = null;
      if (status === "final") {
        if (m.score?.winner === "HOME_TEAM") winner = A.code;
        else if (m.score?.winner === "AWAY_TEAM") winner = B.code;
      }
      const show = status !== "scheduled";
      return {
        id: `m${m.id}`,
        teamA: A, teamB: B,
        scoreA: show ? sc.a : null, scoreB: show ? sc.b : null,
        penaltiesA: sc.pa, penaltiesB: sc.pb,
        status, winner,
        kickoff: m.utcDate || null,
        feedsInto: null,
      };
    });
    return { id: st.id, label: st.label, window: windowOf(built), matches: built };
  });

  // Advancement. The provider sometimes marks a match final but is slow to place
  // its winner in the next round, so we do it ourselves. Matches are sorted by
  // id, and each adjacent pair (2k, 2k+1) are bracket siblings feeding one
  // next-round tie. So once we know where one sibling goes (the provider placed
  // it, or we did), the other goes to the empty slot of the same tie.
  for (let r = 0; r < rounds.length - 1; r++) {
    const here = rounds[r].matches, next = rounds[r + 1];

    // 1. link any winner the provider has already seeded into the next round
    const slot = {};
    next.matches.forEach((m) => {
      if (m.teamA.code) slot[m.teamA.code] = { match: m.id, slot: "A" };
      if (m.teamB.code) slot[m.teamB.code] = { match: m.id, slot: "B" };
    });
    here.forEach((m) => {
      if (m.status === "final" && m.winner && slot[m.winner])
        m.feedsInto = { round: next.id, match: slot[m.winner].match, slot: slot[m.winner].slot };
    });

    // 2. complete the sibling: if one of a pair is linked, the other feeds the
    //    same tie's other slot
    for (let k = 0; k + 1 < here.length; k += 2) {
      const a = here[k], b = here[k + 1];
      if (a.feedsInto && !b.feedsInto && b.status === "final" && b.winner)
        b.feedsInto = { round: a.feedsInto.round, match: a.feedsInto.match, slot: a.feedsInto.slot === "A" ? "B" : "A" };
      else if (b.feedsInto && !a.feedsInto && a.status === "final" && a.winner)
        a.feedsInto = { round: b.feedsInto.round, match: b.feedsInto.match, slot: b.feedsInto.slot === "A" ? "B" : "A" };
    }

    // 3. place every linked winner into its next-round slot
    here.forEach((m) => {
      if (m.status !== "final" || !m.winner || !m.feedsInto) return;
      const tm = next.matches.find((x) => x.id === m.feedsInto.match);
      const w = m.teamA.code === m.winner ? m.teamA : m.teamB;
      if (tm) tm[m.feedsInto.slot === "B" ? "teamB" : "teamA"] = { name: w.name, code: w.code };
    });
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

// Only call the provider when a match is live or about to start.
function inMatchWindow(data) {
  const now = Date.now();
  const PRE = (Number(process.env.PRE_MIN) || 20) * 60_000;
  const POST = (Number(process.env.POST_MIN) || 150) * 60_000;
  return data.rounds.flatMap((r) => r.matches).some((m) => {
    if (m.status === "final") return false;
    if (m.status === "live") return true;
    if (!m.kickoff) return false;
    const dt = new Date(m.kickoff).getTime() - now;
    return dt < PRE && dt > -POST;
  });
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
    if (!inMatchWindow(current)) { console.log("· idle — no match in window, skipped provider call"); return false; }
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
