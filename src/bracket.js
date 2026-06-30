// Data layer. Reports what changed in bracket.json, as fast as the host allows:
//
//  • Live push — subscribes to /events (server-sent events) so a change in the
//    file reaches the page in milliseconds, not on the next poll.
//  • Conditional requests — sends If-None-Match; an unchanged file comes back as
//    a tiny 304 with no body to parse, diff, or re-render.
//  • Adaptive polling fallback — for static hosts with no push channel: fast
//    while a match is live, medium when one kicks off soon, slow when idle.
//  • Tab-aware — pauses while hidden, catches up the instant it's foregrounded.
//
// The renderer stays dumb: it only ever reacts to what this file emits.

const DATA_URL = "public/bracket.json";
const EVENTS_URL = "events";
const INTERVAL = { live: 15_000, soon: 60_000, idle: 300_000, push: 120_000 };
const SOON_WINDOW = 15 * 60_000;   // a kickoff this close counts as "soon"
const RECENT_WINDOW = 3 * 3_600_000; // still poll a match up to 3h past kickoff

export function createBracketSource(url = DATA_URL) {
  let current = null;
  let prevIndex = null;
  let etag = null;
  let timer = null;
  let stopped = true;
  let es = null;       // EventSource (live push)
  let pushLive = false; // true while the push channel is connected
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

  // Pick the next delay from the live state of the bracket. With the push
  // channel connected, polling is just a slow safety net.
  function nextDelay() {
    if (pushLive) return INTERVAL.push;
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

  // Subscribe to the server's push channel. On a host without one (e.g. static
  // hosting) the first error fires before any open, so we give up and poll.
  function connectSSE() {
    if (typeof EventSource === "undefined") return;
    let opened = false;
    try { es = new EventSource(EVENTS_URL); } catch { es = null; return; }
    es.onopen = () => { opened = true; pushLive = true; schedule(); };
    es.onmessage = () => fetchOnce(); // file changed — pull it now
    es.onerror = () => {
      pushLive = false;
      if (!opened) { es.close(); es = null; } // no push endpoint here — poll instead
      schedule(); // browser auto-reconnects EventSource if it had been open
    };
  }

  function start() {
    stopped = false;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
    connectSSE();
    fetchOnce();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    if (es) { es.close(); es = null; }
    pushLive = false;
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibility);
  }

  return { on, start, stop, refresh: fetchOnce, get data() { return current; } };
}
