// Data layer. Polls bracket.json and reports what changed. Built to be cheap:
//
//  • Conditional requests — sends If-None-Match; an unchanged file comes back as
//    a tiny 304 with no body to parse, diff, or re-render.
//  • Adaptive cadence — polls fast while a match is live, medium when one kicks
//    off soon, slow when the tournament is idle.
//  • Tab-aware — pauses entirely while the tab is hidden and catches up the
//    instant it's foregrounded again.
//
// The renderer stays dumb: it only ever reacts to what this file emits.

const DATA_URL = "public/bracket.json";
const INTERVAL = { live: 20_000, soon: 60_000, idle: 300_000 };
const SOON_WINDOW = 15 * 60_000;   // a kickoff this close counts as "soon"
const RECENT_WINDOW = 3 * 3_600_000; // still poll a match up to 3h past kickoff

export function createBracketSource(url = DATA_URL) {
  let current = null;
  let prevIndex = null;
  let etag = null;
  let timer = null;
  let stopped = true;
  const listeners = { update: [], error: [] };

  const on = (event, fn) => {
    (listeners[event] ||= []).push(fn);
    return () => (listeners[event] = listeners[event].filter((f) => f !== fn));
  };
  const emit = (event, payload) => (listeners[event] || []).forEach((fn) => fn(payload));

  function indexOf(data) {
    const map = new Map();
    for (const round of data.rounds)
      for (const m of round.matches)
        map.set(`${round.id}:${m.id}`, { status: m.status, winner: m.winner });
    return map;
  }

  // Pick the next delay from the live state of the bracket.
  function nextDelay() {
    if (!current) return INTERVAL.soon;
    const matches = current.rounds.flatMap((r) => r.matches);
    if (matches.some((m) => m.status === "live")) return INTERVAL.live;
    const now = Date.now();
    const soon = matches.some((m) => {
      if (m.status !== "scheduled" || !m.kickoff) return false;
      const dt = new Date(m.kickoff).getTime() - now;
      return dt < SOON_WINDOW && dt > -RECENT_WINDOW;
    });
    return soon ? INTERVAL.soon : INTERVAL.idle;
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped || (typeof document !== "undefined" && document.hidden)) return;
    timer = setTimeout(fetchOnce, nextDelay());
  }

  async function fetchOnce() {
    let res;
    try {
      res = await fetch(url, {
        cache: "no-store",
        headers: etag ? { "If-None-Match": etag } : {},
      });
    } catch (err) {
      emit("error", err);
      return schedule();
    }

    if (res.status === 304) return schedule(); // unchanged — skip work entirely
    if (!res.ok) {
      emit("error", new Error(`HTTP ${res.status}`));
      return schedule();
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      emit("error", err);
      return schedule();
    }
    etag = res.headers.get("ETag") || etag;

    const index = indexOf(data);
    const isFirst = prevIndex === null;
    const newlyFinal = [];
    if (!isFirst) {
      for (const [key, next] of index) {
        const prev = prevIndex.get(key);
        if (next.status === "final" && (!prev || prev.status !== "final")) {
          const [roundId, matchId] = key.split(":");
          newlyFinal.push({ roundId, matchId, winner: next.winner });
        }
      }
    }
    current = data;
    prevIndex = index;
    emit("update", { data, newlyFinal, isFirst });
    schedule();
  }

  function onVisibility() {
    if (document.hidden) clearTimeout(timer);
    else fetchOnce(); // foregrounded — refresh now, then resume the cadence
  }

  function start() {
    stopped = false;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
    fetchOnce();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibility);
  }

  return { on, start, stop, refresh: fetchOnce, get data() { return current; } };
}
