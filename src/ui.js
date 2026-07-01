import { flagUrl } from "./flags.js";

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmtKick = (iso) => {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
};
const fmtUpdated = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

// Precise phase from status + duration (the provider's PAUSED = half-time).
function phaseLabel(match) {
  if (match.status === "live") return match.providerStatus === "PAUSED" ? "Half-time" : "Live";
  if (match.status === "final") {
    if (match.duration === "PENALTY_SHOOTOUT") return "Penalties";
    if (match.duration === "EXTRA_TIME") return "After extra time";
    return "Full time";
  }
  return "Scheduled";
}

// Extra rows for the collapsible "More details" section — only what the free API
// carries, and only rows that actually have data (so it degrades gracefully).
function moreRows(match) {
  const rows = [];
  if (match.halftimeA != null && match.halftimeB != null)
    rows.push(["Half-time", `${esc(match.halftimeA)}–${esc(match.halftimeB)}`]);
  if (match.referee?.name)
    rows.push(["Referee", esc(match.referee.name) + (match.referee.nationality ? ` (${esc(match.referee.nationality)})` : "")]);
  if (match.venue) rows.push(["Venue", esc(match.venue)]);
  return rows;
}

export function createUI({ onFocusRound, onHighlightRound, onTheme, onFocusLive } = {}) {
  const rail = document.getElementById("rail");
  const panel = document.getElementById("panel");
  const loader = document.getElementById("loader");
  const statusCount = document.getElementById("statusCount");
  const statusUpdated = document.getElementById("statusUpdated");

  let railBuilt = false;
  let currentRound = 0; // auto: the round in play, advances as rounds finish
  let manualRound = null; // a round the user clicked to inspect (overrides)
  let pinnedRef = null; // { roundId, matchId } of the clicked match, for live refresh
  let detailsOpen = false; // is the "More details" section expanded
  let lastPinnedKey = null; // reset detailsOpen when a different match is pinned

  function buildRail(rounds) {
    if (railBuilt) return;
    railBuilt = true;
    const bottomAxis = rail.querySelector(".rail__axis:last-child");
    rounds.forEach((round, r) => {
      const btn = document.createElement("button");
      btn.className = "rail__btn";
      btn.type = "button";
      btn.innerHTML = `<span class="rail__name">${esc(round.label)}</span><span class="rail__meta">${esc(round.window || `${round.matches.length}×`)}</span>`;
      btn.addEventListener("click", () => {
        manualRound = manualRound === r ? null : r;
        const active = manualRound != null ? manualRound : currentRound;
        onFocusRound?.(manualRound);     // dims other rings for inspection (or clears)
        onHighlightRound?.(active);      // moves the gold ring to the active round
        applyActive(active);
      });
      rail.insertBefore(btn, bottomAxis); // sit between the Rim / Core labels
    });
  }

  function applyActive(r) {
    [...rail.querySelectorAll(".rail__btn")].forEach((b, i) =>
      b.setAttribute("aria-current", String(i === r))
    );
  }

  // current round = first round not yet fully decided; once a round's last game
  // is final it advances to the next.
  function currentRoundIndex(data) {
    for (let i = 0; i < data.rounds.length; i++) {
      if (data.rounds[i].matches.some((m) => m.status !== "final")) return i;
    }
    return data.rounds.length - 1;
  }

  function update(data) {
    buildRail(data.rounds);
    currentRound = currentRoundIndex(data);
    // The active (gold-ring) round follows a manual pick, else the current round,
    // so it auto-advances as rounds start and stays put where the user clicked.
    const active = manualRound != null ? manualRound : currentRound;
    applyActive(active);
    onHighlightRound?.(active);

    const cur = data.rounds[currentRound];
    const played = cur.matches.filter((m) => m.status === "final").length;
    const live = data.rounds.flatMap((rd) => rd.matches).filter((m) => m.status === "live").length;
    const tag = (cur.id || "").toUpperCase();
    statusCount.innerHTML = live
      ? `<b>${live}</b> live · ${played}/${cur.matches.length} in ${esc(tag)}`
      : `<b>${played}</b> of ${cur.matches.length} played · ${esc(tag)}`;
    statusUpdated.textContent = data.updated_at ? `Updated ${fmtUpdated(data.updated_at)}` : "";
    liveCount = live;
    applyLiveButton();

    // keep a pinned (clicked) panel showing fresh scores as live data arrives
    if (pinnedRef) {
      const round = data.rounds.find((r) => r.id === pinnedRef.roundId);
      const match = round?.matches.find((m) => m.id === pinnedRef.matchId);
      if (match) showMatch({ round, match }, { pinned: true });
      else hidePanel();
    }
    return currentRound;
  }

  function teamRow(team, score, pens, match) {
    const isPh = !team || team.placeholder || !team.code;
    const isWin = !isPh && match.status === "final" && match.winner === team.code;
    const isOut = !isPh && match.status === "final" && match.winner && match.winner !== team.code;
    const cls = ["team", isPh && "team--ph", isWin && "team--win", isOut && "team--out"].filter(Boolean).join(" ");
    const url = isPh ? null : flagUrl(team.code);
    const flag = url
      ? `<img class="team__flag" src="${url}" alt="" loading="lazy" />`
      : `<span class="team__flag team__flag--blank">${esc(team?.code || "—")}</span>`;
    const scoreCell = match.status === "scheduled" || score == null
      ? ""
      : `<span class="team__score">${esc(score)}${pens != null ? `<span class="team__pens">(${esc(pens)})</span>` : ""}</span>`;
    return `<div class="${cls}">${flag}<span class="team__name">${esc(team?.name || "To be decided")}</span>${scoreCell}</div>`;
  }

  // pinned=true for a clicked match (persists, shows the "More details" toggle,
  // and auto-refreshes on live updates); false for a transient hover preview.
  function showMatch(info, { pinned = false } = {}) {
    if (!info) return hidePanel();
    const { round, match } = info;
    const key = `${round.id}:${match.id}`;
    if (pinned) {
      pinnedRef = { roundId: round.id, matchId: match.id };
      if (key !== lastPinnedKey) { detailsOpen = false; lastPinnedKey = key; } // fresh match starts closed
    }

    const statusClass = match.status === "live" ? "pill--live" : match.status === "final" ? "pill--final" : "pill--scheduled";
    const phase = phaseLabel(match);
    const statusLabel = match.status === "live" ? `<i class="dot dot--live"></i>${esc(phase)}` : esc(phase);
    const title = match.label ? `${round.label} · ${match.label}` : round.label;

    const rows = moreRows(match);
    const showToggle = pinned && rows.length > 0;
    const moreBody = rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join("");
    const moreHtml = showToggle
      ? `<div class="panel__more">
          <button class="panel__more-toggle" type="button" aria-expanded="${detailsOpen}" aria-controls="moreBody">
            <span>More details</span><i class="panel__more-chev" aria-hidden="true"></i>
          </button>
          <dl class="panel__meta panel__more-body${detailsOpen ? " open" : ""}" id="moreBody">${moreBody}</dl>
        </div>`
      : "";

    panel.innerHTML = `
      <div class="panel__round"><span>${esc(title)}</span><span>${esc(round.window || "")}</span></div>
      ${teamRow(match.teamA, match.scoreA, match.penaltiesA, match)}
      <div class="panel__vs"></div>
      ${teamRow(match.teamB, match.scoreB, match.penaltiesB, match)}
      <dl class="panel__meta">
        <dt>Status</dt><dd><span class="pill ${statusClass}">${statusLabel}</span></dd>
        <dt>Kickoff</dt><dd>${esc(fmtKick(match.kickoff))}</dd>
      </dl>
      ${moreHtml}`;
    panel.hidden = false;

    if (showToggle) {
      const btn = panel.querySelector(".panel__more-toggle");
      const body = panel.querySelector(".panel__more-body");
      btn?.addEventListener("click", () => {
        detailsOpen = !detailsOpen; // toggle without a full re-render (keeps scroll)
        btn.setAttribute("aria-expanded", String(detailsOpen));
        body?.classList.toggle("open", detailsOpen);
      });
    }
  }

  function hidePanel() {
    panel.hidden = true;
    pinnedRef = null; // deselecting clears the pin so refreshes stop targeting it
  }

  function hideLoader() {
    loader.classList.add("loader--done");
    setTimeout(() => (loader.style.display = "none"), 850);
  }

  // ---- theme: light is default, choice persists ----
  const toggle = document.getElementById("themeToggle");
  const label = toggle?.querySelector(".theme-toggle__label");
  let theme = localStorage.getItem("wc26-theme") || "light";

  function applyTheme(t, notify = true) {
    theme = t;
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    if (label) label.textContent = t === "dark" ? "Light" : "Dark"; // shows the action
    toggle?.setAttribute("aria-pressed", String(t === "dark"));
    localStorage.setItem("wc26-theme", t);
    if (notify) onTheme?.(t);
  }
  toggle?.addEventListener("click", () => applyTheme(theme === "dark" ? "light" : "dark"));

  // ---- live-focus button (in the legend): jump the wheel to a live game ----
  const liveBtn = document.getElementById("liveBtn");
  let liveCount = 0;
  let liveCycle = 0;
  function applyLiveButton() {
    if (!liveBtn) return;
    const on = liveCount > 0;
    liveBtn.disabled = !on;
    liveBtn.setAttribute("aria-disabled", String(!on));
    liveBtn.title = on ? "Face the live game" : "No live games";
    if (liveCycle >= liveCount) liveCycle = 0;
  }
  liveBtn?.addEventListener("click", () => {
    if (liveBtn.disabled || liveCount === 0) return;
    onFocusLive?.(liveCycle);
    liveCycle = (liveCycle + 1) % liveCount; // cycle through multiple live games
  });

  function initTheme() {
    applyTheme(theme, false); // set DOM + label without notifying (scene not ready yet)
    return theme;
  }

  return { update, showMatch, hidePanel, hideLoader, initTheme };
}
