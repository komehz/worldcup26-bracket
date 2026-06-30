import { createScene } from "./scene.js";
import { createBracketSource } from "./bracket.js";
import { createUI } from "./ui.js";

async function boot() {
  // Wait for the brand fonts so the first card faces render correctly.
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }

  const canvas = document.getElementById("stage");
  let firstPaint = false;

  const ui = createUI({
    onFocusRound: (r) => scene.focusRound(r),
    onHighlightRound: (r) => scene.setCurrentRound(r),
    onTheme: (t) => scene.setTheme(t),
  });

  const scene = createScene(canvas, {
    onHover: (info) => {
      // hover previews a match unless one is pinned by a click
      if (info) ui.showMatch(info);
      else if (!scene.selected) ui.hidePanel();
    },
    onSelect: (info) => {
      if (info) ui.showMatch(info);
      else ui.hidePanel();
    },
    onReady: () => {
      if (!firstPaint) {
        firstPaint = true;
        ui.hideLoader();
      }
    },
  });

  if (new URLSearchParams(location.search).has("debug")) window.__scene = scene;

  // Apply the saved/default theme to the scene before the first frame.
  scene.setTheme(ui.initTheme());

  const source = createBracketSource();
  if (new URLSearchParams(location.search).has("debug")) window.__source = source;
  source.on("update", ({ data, newlyFinal, isFirst }) => {
    scene.setData(data, { newlyFinal, isFirst });
    ui.update(data); // drives the gold guide ring via onHighlightRound
  });
  source.on("error", (err) => {
    console.warn("bracket.json failed to load:", err);
    // Surface a quiet message in the loader if nothing has rendered yet.
    if (!firstPaint) {
      const msg = document.querySelector(".loader__msg");
      if (msg) msg.textContent = "Couldn’t load bracket — retrying";
    }
  });
  source.start();

  // Escape clears a pinned match.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { scene.clearSelection(); ui.hidePanel(); }
  });
}

boot();
