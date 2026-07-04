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

// Half-time score (home/away), or nulls if the provider hasn't recorded it yet.
function halfOf(score) {
  const ht = score?.halfTime || {};
  return { a: ht.home ?? null, b: ht.away ?? null };
}

const fmtDay = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}`;
};
// A round's date label from a list of ISO kickoff times: one day as-is, exactly
// two days joined with "and", and a longer span as "first to last".
function windowOfDates(isoList) {
  const iso = isoList.filter(Boolean).sort();
  if (!iso.length) return "";
  const days = [...new Set(iso.map(fmtDay))]; // ascending (iso is sorted)
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days[0]} to ${days[days.length - 1]}`;
}
const windowOf = (matches) => windowOfDates(matches.map((m) => m.kickoff));

async function fetchMatches(token) {
  const res = await fetch(API, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
  const json = await res.json();
  // A 200 with no matches is an error-shaped response, not a schedule: the
  // provider once served exactly that and a hollow bracket got committed over
  // good data. Fail the run instead; the next tick retries.
  if (!Array.isArray(json.matches) || json.matches.length === 0)
    throw new Error(`provider returned no matches (${JSON.stringify(json).slice(0, 160)})`);
  return json.matches;
}

// ---- second-source cross-check (ESPN public scoreboard, no key) ------------
// football-data.org has served wrong finals more than once (a VAR-disallowed
// goal left in as 2-2, a 4-4 "finished" shootout). ESPN's public scoreboard is
// keyless, fast, and uses the same three-letter codes for all 32 teams, so we
// verify every result against it: a match only renders as final once BOTH
// sources say it is, and if they disagree on a final score ESPN wins (it has
// been right every time the two diverged). overrides.json still trumps both.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

async function fetchEspn(matches) {
  const days = matches.map((m) => m.utcDate).filter(Boolean).map((d) => d.slice(0, 10).replace(/-/g, "")).sort();
  if (!days.length) return null;
  const res = await fetch(`${ESPN}?dates=${days[0]}-${days[days.length - 1]}`);
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const json = await res.json();
  const map = {};
  for (const e of json.events || []) {
    const comps = e.competitions?.[0]?.competitors || [];
    const h = comps.find((c) => c.homeAway === "home"), a = comps.find((c) => c.homeAway === "away");
    const ha = h?.team?.abbreviation, aa = a?.team?.abbreviation;
    if (!ha || !aa) continue;
    map[[ha, aa].sort().join("-")] = {
      completed: Boolean(e.status?.type?.completed),
      state: e.status?.type?.state, // pre | in | post
      score: { [ha]: Number(h.score), [aa]: Number(a.score) },
      pens: h.shootoutScore != null || a.shootoutScore != null
        ? { [ha]: Number(h.shootoutScore ?? 0), [aa]: Number(a.shootoutScore ?? 0) }
        : null,
      winner: h.winner ? ha : a.winner ? aa : null,
    };
  }
  return map;
}

// Rewrite one raw fixture's score from the ESPN record (keeps fd's half-time).
function espnScoreFor(pm, E) {
  const ht = pm.homeTeam?.tla, at = pm.awayTeam?.tla;
  const score = {
    winner: E.winner === ht ? "HOME_TEAM" : E.winner === at ? "AWAY_TEAM" : null,
    duration: E.pens ? "PENALTY_SHOOTOUT" : "REGULAR",
    fullTime: { home: E.score[ht], away: E.score[at] },
    halfTime: pm.score?.halfTime || {},
  };
  if (E.pens) score.penalties = { home: E.pens[ht], away: E.pens[at] };
  return score;
}

function crossCheck(matches, espn, overrides) {
  for (const pm of matches) {
    const ht = pm.homeTeam?.tla, at = pm.awayTeam?.tla;
    if (!ht || !at) continue; // tie not seeded yet
    if (overrides[String(pm.id)]) continue; // a human override outranks ESPN
    const E = espn[[ht, at].sort().join("-")];
    if (!E) continue; // no counterpart found: fall back to single-source
    const fdFinal = ["FINISHED", "AWARDED"].includes(pm.status);

    if (fdFinal && E.completed) {
      // both final: compare goals, shootout and winner; ESPN wins a conflict
      const fdGoals = (() => {
        const s = pm.score || {};
        if (s.penalties) {
          const rt = s.regularTime || s.fullTime || {}, et = s.extraTime || {};
          return { home: (rt.home ?? 0) + (et.home ?? 0), away: (rt.away ?? 0) + (et.away ?? 0) };
        }
        return { home: s.fullTime?.home, away: s.fullTime?.away };
      })();
      const pensDiffer =
        Boolean(pm.score?.penalties) !== Boolean(E.pens) ||
        (E.pens && (pm.score.penalties.home !== E.pens[ht] || pm.score.penalties.away !== E.pens[at]));
      const fdWinnerCode = pm.score?.winner === "HOME_TEAM" ? ht : pm.score?.winner === "AWAY_TEAM" ? at : null;
      if (fdGoals.home !== E.score[ht] || fdGoals.away !== E.score[at] || pensDiffer || fdWinnerCode !== E.winner) {
        console.warn(`± cross-check ${ht}v${at}: provider ${fdGoals.home}-${fdGoals.away} disagrees with ESPN ${E.score[ht]}-${E.score[at]}${E.pens ? ` (pens ${E.pens[ht]}-${E.pens[at]})` : ""} — using ESPN`);
        pm.score = espnScoreFor(pm, E);
      }
    } else if (fdFinal && !E.completed) {
      // provider claims final but ESPN does not confirm: hold as in play
      console.warn(`± cross-check ${ht}v${at}: provider says FINISHED but ESPN says "${E.state}" — holding until both agree`);
      pm.status = "IN_PLAY";
    } else if (!fdFinal && E.completed && E.winner) {
      // ESPN finished first (provider lagging): promote with ESPN's result
      console.warn(`± cross-check ${ht}v${at}: ESPN final ${E.score[ht]}-${E.score[at]}, provider still "${pm.status}" — promoting`);
      pm.status = "FINISHED";
      pm.score = espnScoreFor(pm, E);
    }
  }
  return matches;
}

// Manual corrections for wrong provider data (e.g. a VAR-disallowed goal left
// in the feed). overrides.json maps a provider match id to a patch deep-merged
// onto the raw fixture BEFORE the bracket is built, so scores, winner and
// advancement all flow from the corrected data. Delete an entry once the
// provider fixes itself.
async function loadOverrides() {
  try {
    return JSON.parse(await readFile(fileURLToPath(new URL("./overrides.json", import.meta.url)), "utf8"));
  } catch {
    return {};
  }
}
function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") deepMerge(base[k], v);
    else base[k] = v;
  }
}
function applyOverrides(matches, overrides) {
  for (const m of matches) {
    const o = overrides[String(m.id)];
    if (!o?.patch) continue;
    deepMerge(m, o.patch);
    console.log(`· override applied to ${m.id}${o.note ? ` — ${o.note}` : ""}`);
  }
  return matches;
}

// Turn one provider fixture into a displayed match, oriented so (teamA, teamB)
// line up with the given team objects. For the Round of 32 those are just the
// provider's home/away; for inner rounds they are the two feeder winners, and
// the fixture (found by matching both teams) supplies score/status/kickoff.
function makeMatch(id, A, B, pm) {
  let status = "scheduled", winner = null, kickoff = null;
  let sc = { a: null, b: null, pa: null, pb: null };
  let ht = { a: null, b: null };
  let duration = null, providerStatus = null, referee = null, wentToExtraTime = false;
  if (pm) {
    status = statusOf(pm.status);
    providerStatus = pm.status || null; // raw status keeps the PAUSED = half-time signal
    kickoff = pm.utcDate || null;
    duration = pm.score?.duration || null; // REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT (unreliable — flip-flops live)
    const et = pm.score?.extraTime; // trustworthy: present once a tie goes to extra time
    wentToExtraTime = !!(et && (et.home != null || et.away != null));
    const raw = scoreOf(pm.score);
    const rawHt = halfOf(pm.score);
    const homeIsA = pm.homeTeam?.tla === A.code;
    sc = homeIsA ? raw : { a: raw.b, b: raw.a, pa: raw.pb, pb: raw.pa };
    ht = homeIsA ? rawHt : { a: rawHt.b, b: rawHt.a };
    if (status === "final") {
      if (pm.score?.winner === "HOME_TEAM") winner = homeIsA ? A.code : B.code;
      else if (pm.score?.winner === "AWAY_TEAM") winner = homeIsA ? B.code : A.code;
      // provider slow to set score.winner: derive it from the scores themselves
      else if (sc.pa != null && sc.pb != null && sc.pa !== sc.pb) winner = sc.pa > sc.pb ? A.code : B.code;
      else if (sc.a != null && sc.b != null && sc.a !== sc.b) winner = sc.a > sc.b ? A.code : B.code;
      // Sanity guard: a knockout tie cannot finish without a winner (a level
      // game goes to extra time, then penalties). FINISHED with no winner is
      // impossible data — e.g. a VAR-disallowed goal left in the feed — so hold
      // the tie as undecided instead of rendering a final draw that advances
      // no one. It resolves itself when the provider corrects (or via
      // overrides.json).
      if (!winner) {
        console.warn(`! ${id}: FINISHED but no winner (${sc.a}-${sc.b}, pens ${sc.pa}-${sc.pb}) — holding as undecided`);
        status = "live";
      }
    }
    const ref = pm.referees?.[0];
    if (ref?.name) referee = { name: ref.name, nationality: ref.nationality || null };
  }
  const show = status !== "scheduled";
  return {
    id,
    teamA: A, teamB: B,
    scoreA: show ? sc.a : null, scoreB: show ? sc.b : null,
    penaltiesA: sc.pa, penaltiesB: sc.pb,
    halftimeA: show ? ht.a : null, halftimeB: show ? ht.b : null,
    duration, providerStatus, referee, wentToExtraTime,
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
    // Date label comes from the provider's own schedule for this stage, which
    // has kickoff dates even before the teams are known — so QF/SF/Final still
    // show their dates while their ties are placeholders.
    const win = windowOfDates(prov.map((m) => m.utcDate));
    rounds.push({ id: STAGES[s].id, label: STAGES[s].label, window: win, matches: ties });
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
// An EMPTY bracket also counts as pending: treating no-matches as "all final"
// once deadlocked the pipeline after a hollow file got written.
function hasPendingMatches(data) {
  const ms = data.rounds.flatMap((r) => r.matches);
  return ms.length === 0 || ms.some((m) => m.status !== "final");
}

// Results never un-happen: a rebuild with fewer matches or fewer finished
// matches than the file we already have means degraded provider data (an
// empty 200, a half-populated schedule), never a real schedule change. Refuse
// to replace good data with worse.
function regressed(current, next) {
  const count = (d) => d.rounds.flatMap((r) => r.matches).length;
  const finals = (d) => d.rounds.flatMap((r) => r.matches).filter((m) => m.status === "final").length;
  if (count(next) < count(current)) return `match count ${count(current)} -> ${count(next)}`;
  if (finals(next) < finals(current)) return `finished count ${finals(current)} -> ${finals(next)}`;
  return null;
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
    const matches = await fetchMatches(token);
    const overrides = await loadOverrides();
    try {
      const espn = await fetchEspn(matches);
      if (espn) crossCheck(matches, espn, overrides);
    } catch (err) {
      console.warn(`± cross-check skipped (ESPN unavailable: ${err.message}) — single-source run`);
    }
    next = buildBracket(applyOverrides(matches, overrides));
  }

  if (!DEMO) {
    const worse = regressed(current, next);
    if (worse) { console.error(`✗ refusing to write degraded bracket (${worse}) — keeping current data`); return false; }
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
