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

export function createUI({ onFocusRound, onHighlightRound, onTheme } = {}) {
  const rail = document.getElementById("rail");
  const panel = document.getElementById("panel");
  const loader = document.getElementById("loader");
  const statusCount = document.getElementById("statusCount");
  const statusUpdated = document.getElementById("statusUpdated");

  let railBuilt = false;
  let currentRound = 0; // auto: the round in play, advances as rounds finish
  let manualRound = null; // a round the user clicked to inspect (overrides)

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

  function showMatch(info) {
    if (!info) return hidePanel();
    const { round, match } = info;
    const statusClass = match.status === "live" ? "pill--live" : match.status === "final" ? "pill--final" : "pill--scheduled";
    const statusLabel = match.status === "live"
      ? `<i class="dot dot--live"></i>Live`
      : match.status === "final" ? "Full time" : "Scheduled";
    const title = match.label ? `${round.label} · ${match.label}` : round.label;

    panel.innerHTML = `
      <div class="panel__round"><span>${esc(title)}</span><span>${esc(round.window || "")}</span></div>
      ${teamRow(match.teamA, match.scoreA, match.penaltiesA, match)}
      <div class="panel__vs"></div>
      ${teamRow(match.teamB, match.scoreB, match.penaltiesB, match)}
      <dl class="panel__meta">
        <dt>Status</dt><dd><span class="pill ${statusClass}">${statusLabel}</span></dd>
        <dt>Kickoff</dt><dd>${esc(fmtKick(match.kickoff))}</dd>
        ${match.venue ? `<dt>Venue</dt><dd>${esc(match.venue)}</dd>` : ""}
      </dl>`;
    panel.hidden = false;
  }

  function hidePanel() {
    panel.hidden = true;
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

  function initTheme() {
    applyTheme(theme, false); // set DOM + label without notifying (scene not ready yet)
    return theme;
  }

  return { update, showMatch, hidePanel, hideLoader, initTheme };
}
