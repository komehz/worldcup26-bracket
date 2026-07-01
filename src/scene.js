import * as THREE from "three";
import { flagUrl } from "./flags.js";

// ----------------------------------------------------------------------------
// Tunables — the whole geometry is parameterised so one function builds every
// ring. Rings shrink and lift inward; the trophy floats above the core.
// ----------------------------------------------------------------------------
const BASE_RADIUS = 10.7;
const RADIUS_STEP = 1.62;
const RING_LIFT = 1.5; // each ring inward rises toward the trophy (stepped cone)
const TILT = 0; // no tilt — the stack spins about a true vertical axis only
const CARD_W = 1.34;
const CARD_H = 0.9;
// Centre-to-centre arc (world units) between a match's two opponents — a fixed
// small gap, so opponents read as a tight pair in *every* round (not just the
// Round of 32, where the slice happens to be narrow).
const PAIR_ARC = 1.55;
// Each card pitches back about its own tangent so its face tilts up toward the
// raised camera — whatever flag is at the front reads straight-on, like a flag
// facing you, while the spin axis stays vertical.
const CARD_PITCH = -0.6;

const GOLD = 0xd4af6a;

// Two themes. Light is the default; the same 3D scene re-colours at runtime.
const THEMES = {
  light: {
    name: "light",
    bg: 0xece9e1, fogNear: 22, fogFar: 54,
    ambient: 0xffffff, ambientI: 1.5, rimI: 0.32, coreI: 0.45,
    guide: 0xbeb8aa, guideOn: 0xa9701c, guideOpacity: 0.85, line: 0xcdc8ba, frameElim: 0xdedacf,
    beam: 0xb8893f, glow: 0.18, gemEmissive: 0.5, liveHalo: 1.6,
    card: {
      bg: "#e9e6df", noFlag: "#dcd8ce", grad: "246,243,236", gradMax: 0.8,
      ink: "#1b1b1e", inkSoft: "rgba(27,27,30,0.6)", muted: "#6c6a63",
      phFill: "#d4d0c5", phInk: "#56544c", dashed: "rgba(0,0,0,0.34)",
      winnerInk: "#9b7426", mutedStat: "rgba(108,106,99,0.95)", pens: "rgba(155,116,38,0.95)",
      elimFilter: "grayscale(0.6) brightness(1.0)", elimInk: "#7d7b73",
      elimSoft: "rgba(110,108,100,0.85)",
    },
  },
  dark: {
    name: "dark",
    bg: 0x0a0a0c, fogNear: 18, fogFar: 44,
    ambient: 0x6a6a78, ambientI: 0.85, rimI: 0.55, coreI: 1.0,
    guide: 0x3a3a42, guideOn: GOLD, guideOpacity: 0.6, line: 0x2b2b30, frameElim: 0x26262e,
    beam: GOLD, glow: 0.7, gemEmissive: 0.35, liveHalo: 1.0,
    card: {
      bg: "#121317", noFlag: "#17171c", grad: "8,8,10", gradMax: 0.82,
      ink: "#f5f4f0", inkSoft: "rgba(245,244,240,0.72)", muted: "#8d8d92",
      phFill: "#43454f", phInk: "rgba(214,216,225,0.96)", dashed: "rgba(255,255,255,0.5)",
      winnerInk: "#e7c886", mutedStat: "rgba(141,141,146,0.9)", pens: "rgba(212,175,106,0.85)",
      elimFilter: "grayscale(0.78) brightness(0.95)", elimInk: "#b6b6bc",
      elimSoft: "rgba(176,176,184,0.78)",
    },
  },
};

const ringRadius = (r) => BASE_RADIUS - r * RADIUS_STEP;
const ringHeight = (r) => r * RING_LIFT;
const slotRotY = (angle) => Math.PI / 2 - angle; // radial-outward face
const posFromAngle = (r, a) =>
  new THREE.Vector3(Math.cos(a) * ringRadius(r), ringHeight(r), Math.sin(a) * ringRadius(r));

// circular mean of angles, and shortest angular distance
const circMean = (a) => {
  let x = 0, y = 0;
  for (const v of a) { x += Math.cos(v); y += Math.sin(v); }
  return Math.atan2(y, x);
};
const angDist = (a, b) => {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(d, Math.PI * 2 - d);
};
// signed shortest angular delta from a to b, in [-PI, PI] — for a short-path spin
const angDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const shortDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" }).toUpperCase()}`;
};

// ----------------------------------------------------------------------------
// Flag image cache (shared — a team appears in more than one ring once it
// advances, so both cards reuse the same decoded image).
// ----------------------------------------------------------------------------
const flagCache = new Map();
function loadFlag(url, onReady) {
  if (!url) return null;
  let entry = flagCache.get(url);
  if (entry) {
    if (entry.img) onReady(entry.img);
    else entry.waiting.push(onReady);
    return entry.img;
  }
  entry = { img: null, waiting: [onReady] };
  flagCache.set(url, entry);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    entry.img = img;
    entry.waiting.forEach((fn) => fn(img));
    entry.waiting = [];
  };
  img.onerror = () => { entry.waiting = []; };
  img.src = url;
  return null;
}

// ----------------------------------------------------------------------------
// Card face — drawn to a canvas so we own the whole composition. Flag fills the
// card; a dark gradient anchors the type; state drives colour and treatment.
// ----------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCard(ctx, W, H, o, C) {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  roundRect(ctx, 2, 2, W - 4, H - 4, 18);
  ctx.clip();

  // base
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  if (o.state === "placeholder") {
    ctx.fillStyle = C.phFill; // lighter than the base so the socket reads
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.strokeStyle = C.dashed;
    ctx.lineWidth = 2.5;
    roundRect(ctx, 5, 5, W - 10, H - 10, 16);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.phInk;
    ctx.font = `600 ${Math.round(W * 0.066)}px "Inter", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    wrapText(ctx, (o.name || "TBD").toUpperCase(), W / 2, H / 2, W - 48, W * 0.085);
    ctx.restore();
    return;
  }

  // flag, cover-fit
  if (o.flagImg) {
    const img = o.flagImg;
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    if (o.state === "eliminated") ctx.filter = C.elimFilter;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.filter = "none";
  } else {
    ctx.fillStyle = C.noFlag;
    ctx.fillRect(0, 0, W, H);
  }

  // Legibility wash behind the type — starts low and stops short of opaque so
  // most of the flag stays visible and the base isn't crushed to black/white.
  const gradMax = C.gradMax ?? 0.85;
  const grad = ctx.createLinearGradient(0, H * 0.5, 0, H);
  grad.addColorStop(0, `rgba(${C.grad},0)`);
  grad.addColorStop(0.55, `rgba(${C.grad},${(gradMax * 0.45).toFixed(2)})`);
  grad.addColorStop(1, `rgba(${C.grad},${gradMax})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // winner accent — a thin gold rule along the top
  if (o.state === "winner") {
    ctx.fillStyle = "#d4af6a";
    ctx.fillRect(0, 0, W, 6);
  }

  const pad = Math.round(W * 0.07);
  const isOut = o.state === "eliminated";
  const mainInk = o.state === "winner" ? C.winnerInk : isOut ? C.elimInk : C.ink;

  // code
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = mainInk;
  ctx.font = `800 ${Math.round(W * 0.115)}px "Inter", sans-serif`;
  ctx.fillText(o.code || "", pad, H - Math.round(H * 0.17));

  // name
  ctx.fillStyle = isOut ? C.elimSoft : C.inkSoft;
  ctx.font = `500 ${Math.round(W * 0.05)}px "Inter", sans-serif`;
  ctx.fillText(truncate(ctx, o.name || "", W - pad * 2), pad, H - Math.round(H * 0.075));

  // stat (score digit, or short date)
  ctx.textAlign = "right";
  if (o.statText) {
    if (o.statBig) {
      ctx.fillStyle = mainInk;
      ctx.font = `500 ${Math.round(W * 0.16)}px "IBM Plex Mono", monospace`;
      ctx.fillText(o.statText, W - pad, H - Math.round(H * 0.13));
      if (o.pensText) {
        ctx.fillStyle = C.pens;
        ctx.font = `500 ${Math.round(W * 0.052)}px "IBM Plex Mono", monospace`;
        ctx.fillText(o.pensText, W - pad, H - Math.round(H * 0.04));
      }
    } else {
      ctx.fillStyle = C.mutedStat;
      ctx.font = `500 ${Math.round(W * 0.05)}px "IBM Plex Mono", monospace`;
      ctx.fillText(o.statText, W - pad, H - Math.round(H * 0.085));
    }
  }

  ctx.restore();
}

function truncate(ctx, str, maxW) {
  if (ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
function wrapText(ctx, text, cx, cy, maxW, lh) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lh));
}

// ----------------------------------------------------------------------------
// Scene
// ----------------------------------------------------------------------------
export function createScene(canvas, { onHover, onSelect, onReady } = {}) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let T = THEMES.light; // active theme

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(T.bg, T.fogNear, T.fogFar);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const camState = { dist: 28, height: 13, lookY: 1.2 };
  const camTarget = { ...camState };

  // lights: ambient + key + gold rim + trophy point light
  const ambient = new THREE.AmbientLight(T.ambient, T.ambientI);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xfff4e2, 1.1);
  key.position.set(6, 16, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(GOLD, T.rimI);
  rim.position.set(-8, 5, -10);
  scene.add(rim);
  const core = new THREE.PointLight(GOLD, 1.4, 30, 1.6);
  core.position.set(0, ringHeight(4) + 1.7, 0);
  scene.add(core);

  // group hierarchy: spinGroup -> tiltGroup -> rings (only spin is animated)
  const spinGroup = new THREE.Group();
  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.x = TILT;
  spinGroup.add(tiltGroup);
  scene.add(spinGroup);

  const ringGroups = [];
  const guideMats = [];
  for (let r = 0; r < 5; r++) {
    const g = new THREE.Group();
    tiltGroup.add(g);
    ringGroups.push(g);
    // faint guide circle so each ring track reads even where slots are empty
    const seg = 160;
    const pts = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * ringRadius(r), ringHeight(r), Math.sin(a) * ringRadius(r)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: T.guide, transparent: true, opacity: T.guideOpacity });
    guideMats.push(mat);
    tiltGroup.add(new THREE.Line(geo, mat));
  }

  const trophy = buildTrophy();
  trophy.position.y = ringHeight(4) + 1.7;
  tiltGroup.add(trophy);

  // beams + cards live here
  const beamGroup = new THREE.Group();
  tiltGroup.add(beamGroup);
  const cards = new Map(); // key -> cardObj
  const beams = new Map(); // matchKey -> beamObj
  const pickables = [];

  let layout = null; // derived from data: round index + match index lookups
  let dataRef = null;
  let highlightRound = null;
  let currentRound = null;

  // ---- card factory ----
  function makeCard(key, roundIndex) {
    const canvasEl = document.createElement("canvas");
    canvasEl.width = 384; canvasEl.height = 256;
    const ctx = canvasEl.getContext("2d");
    const texture = new THREE.CanvasTexture(canvasEl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const faceMat = new THREE.MeshStandardMaterial({
      map: texture, transparent: true, roughness: 0.62, metalness: 0.0,
      emissive: GOLD, emissiveIntensity: 0, side: THREE.DoubleSide,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: T.line, transparent: true, roughness: 0.5, metalness: 0.1,
      emissive: GOLD, emissiveIntensity: 0, side: THREE.DoubleSide,
    });

    const group = new THREE.Group();
    // YXZ: heading (radial facing) first, then pitch about the card's own tangent.
    group.rotation.order = "YXZ";
    group.rotation.x = CARD_PITCH;
    // A soft additive gold plane behind the card, only shown (and pulsed) for live
    // matches, so a live game reads as a glowing tile without a bloom pass.
    const haloMat = new THREE.MeshBasicMaterial({
      color: GOLD, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W + 0.5, CARD_H + 0.5), haloMat);
    halo.position.z = -0.02;
    halo.visible = false;
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W + 0.09, CARD_H + 0.09), frameMat);
    frame.position.z = -0.012;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), faceMat);
    face.userData.key = key;
    group.add(halo, frame, face);
    ringGroups[roundIndex].add(group);
    pickables.push(face); // halo/frame stay out of the pick path

    return {
      key, roundIndex, group, face, frame, faceMat, frameMat, halo, haloMat, ctx, canvasEl, texture,
      base: new THREE.Vector3(), outward: new THREE.Vector3(), baseRotY: 0,
      hover: 0, sink: 0, dim: 1, baseOpacity: 1, flagImg: null, sig: "",
      flagUrl: null, state: "upcoming", travel: null, model: null,
    };
  }

  function redraw(card) {
    drawCard(card.ctx, card.canvasEl.width, card.canvasEl.height,
      { ...card.model, flagImg: card.flagImg }, T.card);
    card.texture.needsUpdate = true;
  }

  const frameColorFor = (state) =>
    state === "winner" || state === "live" ? GOLD : state === "eliminated" ? T.frameElim : T.line;

  // ---- build / update from data ----
  function buildLayout(data) {
    const rounds = data.rounds;
    const roundIndexById = {};
    const matchIndexById = {};
    rounds.forEach((round, r) => {
      roundIndexById[round.id] = r;
      matchIndexById[round.id] = {};
      round.matches.forEach((m, mi) => (matchIndexById[round.id][m.id] = mi));
    });

    // Match-centre angles. Round of 32 is evenly spaced. For each inner round we
    // form candidate slots at the centre of every adjacent feeder pair (where a
    // tie belongs), seat each tie whose feeders are known at its slot, then fill
    // the leftover slots with the not-yet-seeded placeholder ties. That keeps a
    // seeded tie centred between its feeders while never letting a placeholder
    // land on top of it.
    const centers = rounds.map((round) => new Array(round.matches.length).fill(0));
    const n0 = rounds[0].matches.length;
    for (let k = 0; k < n0; k++) centers[0][k] = (k / n0) * Math.PI * 2;

    for (let r = 1; r < rounds.length; r++) {
      const prev = centers[r - 1];
      const here = rounds[r].matches;
      const nr = here.length;

      const feeders = here.map(() => []);
      rounds[r - 1].matches.forEach((om, omi) => {
        const f = om.feedsInto;
        if (f && roundIndexById[f.round] === r) {
          const tm = matchIndexById[f.round][f.match];
          if (tm != null) feeders[tm].push(omi);
        }
      });

      // Candidate slots come from the Round-of-32 ring, which is evenly spaced
      // and never re-seated. Each tie owns a contiguous block of R32 matches, so
      // its slot is that block's centre. Deriving from R32 (rather than the
      // immediate parent, whose index order no longer tracks its angular order
      // after seeded ties are re-seated) keeps every inner round evenly spaced.
      const slots = [];
      const group = nr > 0 && n0 % nr === 0 ? n0 / nr : 0;
      for (let k = 0; k < nr; k++) {
        if (!group) { slots.push((k / nr) * Math.PI * 2); continue; }
        const seg = [];
        for (let j = 0; j < group; j++) seg.push(centers[0][k * group + j]);
        slots.push(circMean(seg));
      }
      const want = here.map((_, mi) => (feeders[mi].length ? circMean(feeders[mi].map((o) => prev[o])) : null));

      const taken = new Array(nr).fill(false);
      here.forEach((_, mi) => {
        if (want[mi] == null) return;
        let best = -1, bd = Infinity;
        for (let s = 0; s < nr; s++) {
          if (taken[s]) continue;
          const d = angDist(slots[s], want[mi]);
          if (d < bd) { bd = d; best = s; }
        }
        if (best >= 0) { taken[best] = true; centers[r][mi] = slots[best]; }
      });
      let s = 0;
      here.forEach((_, mi) => {
        if (want[mi] != null) return;
        while (s < nr && taken[s]) s++;
        taken[s] = true;
        centers[r][mi] = slots[s];
      });
    }
    return { rounds, roundIndexById, matchIndexById, centers };
  }

  // Angle for one card. Opponents sit a fixed arc apart (tight in every round).
  // The final round is special: the two finalists face off on opposite sides of
  // the trophy, with the third-place pair opposite on the perpendicular axis.
  function slotAngleFor(r, mi, slot) {
    const last = layout.rounds.length - 1;
    if (r === last && layout.centers[r - 1]?.length >= 2) {
      const sf = layout.centers[r - 1];
      const axis = (slot === "A" ? sf[0] : sf[1]) + (mi === 0 ? 0 : Math.PI / 2);
      return axis;
    }
    const half = PAIR_ARC / (2 * ringRadius(r)); // arc -> angle at this radius
    return layout.centers[r][mi] + (slot === "A" ? -half : half);
  }

  function slotInfo(roundId, matchId, slot) {
    const r = layout.roundIndexById[roundId];
    const mi = layout.matchIndexById[roundId][matchId];
    const angle = slotAngleFor(r, mi, slot);
    return { r, mi, angle, pos: posFromAngle(r, angle), rotY: slotRotY(angle) };
  }

  function cardModel(round, match, slot) {
    const team = slot === "A" ? match.teamA : match.teamB;
    const isPh = !team || team.placeholder || !team.code;
    const score = slot === "A" ? match.scoreA : match.scoreB;
    const pens = slot === "A" ? match.penaltiesA : match.penaltiesB;
    let state = "upcoming";
    if (isPh) state = "placeholder";
    else if (match.status === "final") state = match.winner === team.code ? "winner" : "eliminated";
    else if (match.status === "live") state = "live";

    let statText = "", statBig = false, pensText = "";
    if (!isPh) {
      if (match.status === "final" || match.status === "live") {
        statText = score == null ? "–" : String(score);
        statBig = true;
        if (pens != null) pensText = `(${pens})`;
      } else {
        statText = shortDate(match.kickoff);
      }
    }
    return {
      state, code: isPh ? "" : team.code, name: team ? team.name : "TBD",
      statText, statBig, pensText, flagUrl: isPh ? null : flagUrl(team.code),
    };
  }

  const baseOpacityFor = (s) =>
    s === "winner" ? 1 : s === "live" ? 1 : s === "eliminated" ? 0.62 : s === "placeholder" ? 0.68 : 0.96;

  function setData(data, { newlyFinal = [], isFirst = false } = {}) {
    dataRef = data;
    layout = buildLayout(data);
    const seen = new Set();

    data.rounds.forEach((round) => {
      round.matches.forEach((match) => {
        ["A", "B"].forEach((slot) => {
          const key = `${round.id}:${match.id}:${slot}`;
          seen.add(key);
          const info = slotInfo(round.id, match.id, slot);
          const model = cardModel(round, match, slot);

          let card = cards.get(key);
          if (!card) { card = makeCard(key, info.r); cards.set(key, card); }

          card.base.copy(info.pos);
          card.outward.set(Math.cos(info.angle), 0, Math.sin(info.angle));
          card.baseRotY = info.rotY;
          card.state = model.state;
          card.model = model;
          card.baseOpacity = baseOpacityFor(model.state);

          // (re)draw only when the visible content changed
          const sig = `${model.state}|${model.code}|${model.name}|${model.statText}|${model.pensText}`;
          if (sig !== card.sig || card.flagUrl !== model.flagUrl) {
            card.sig = sig;
            if (model.flagUrl && card.flagUrl !== model.flagUrl) {
              card.flagImg = null;
              const cached = loadFlag(model.flagUrl, (img) => {
                card.flagImg = img;
                redraw(card);
              });
              if (cached) card.flagImg = cached;
            }
            if (!model.flagUrl) card.flagImg = null;
            redraw(card);
          }
          card.flagUrl = model.flagUrl;
          card.frameMat.color.setHex(frameColorFor(model.state));

          // place at home unless it is mid-travel
          if (!card.travel) {
            card.group.position.copy(card.base);
            card.group.rotation.y = card.baseRotY;
          }
          card.sink = model.state === "eliminated" ? 1 : 0;
        });
      });
    });

    // remove cards no longer present
    for (const [key, card] of cards) {
      if (!seen.has(key)) { disposeCard(card); cards.delete(key); }
    }

    // beams for every decided match (winner -> next ring)
    data.rounds.forEach((round) => {
      round.matches.forEach((match) => {
        if (match.status === "final" && match.winner && match.feedsInto) {
          ensureBeam(round, match, isFirst);
        }
      });
    });

    // advance flourish for matches that just flipped to final
    if (!isFirst && !reduce) {
      newlyFinal.forEach(({ roundId, matchId }) => {
        const round = data.rounds.find((rd) => rd.id === roundId);
        const match = round?.matches.find((m) => m.id === matchId);
        if (match && match.winner && match.feedsInto) playAdvance(round, match);
      });
    }

    // on first load, spin so a match being played today faces the viewer
    if (isFirst) faceTodayMatch(data);

    if (onReady) onReady();
  }

  // Rotate the stack so the chosen R32 match sits at the front (+Z, toward the
  // camera). Picks the earliest still-to-play match on the data's own day, else
  // the next upcoming one.
  function faceTodayMatch(data) {
    const r32 = data.rounds[0];
    const ref = new Date(data.updated_at || Date.now());
    const sameDay = (d) =>
      d.getUTCFullYear() === ref.getUTCFullYear() &&
      d.getUTCMonth() === ref.getUTCMonth() &&
      d.getUTCDate() === ref.getUTCDate();
    const live = r32.matches.filter((m) => m.status === "live");
    const upcoming = r32.matches
      .filter((m) => m.status !== "final" && m.kickoff)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const target =
      live[0] ||
      upcoming.find((m) => sameDay(new Date(m.kickoff))) ||
      upcoming[0] ||
      r32.matches[0];
    if (!target) return;
    const mi = layout.matchIndexById.R32[target.id];
    const aCard = layout.centers[0][mi]; // centre of the match's two cards
    rotTarget = aCard - Math.PI / 2; // front of the stack is world angle +π/2
    rotCurrent = rotTarget; // start already facing it, no spin-in on load
  }

  // Ease the wheel so a live match faces the viewer. Scans every round (a live
  // game can be in any ring) and cycles through them on repeated calls. Unlike
  // faceTodayMatch it sets only rotTarget, so the existing ease animates the
  // spin, and it takes the short way round. Returns { count } for the UI.
  function faceLiveMatch(cycleIndex = 0) {
    if (!layout || !dataRef) return { count: 0 };
    const live = [];
    dataRef.rounds.forEach((round) => {
      const r = layout.roundIndexById[round.id];
      round.matches.forEach((m) => {
        if (m.status !== "live") return;
        const mi = layout.matchIndexById[round.id]?.[m.id];
        if (r != null && mi != null) live.push({ r, mi });
      });
    });
    if (!live.length) return { count: 0 };
    const pick = live[((cycleIndex % live.length) + live.length) % live.length];
    const desired = layout.centers[pick.r][pick.mi] - Math.PI / 2;
    rotTarget = rotCurrent + angDelta(rotCurrent, desired); // shortest path, animated
    spinVel = 0; flingVel = 0;
    if (reduce) rotCurrent = rotTarget; // respect reduced motion: no spin-in
    markInteract();
    return { count: live.length };
  }

  function winnerSlotOf(match) {
    if (match.winner === match.teamA?.code) return "A";
    if (match.winner === match.teamB?.code) return "B";
    return null;
  }

  function beamCurve(round, match) {
    const wslot = winnerSlotOf(match);
    if (!wslot) return null;
    const src = slotInfo(round.id, match.id, wslot).pos;
    const f = match.feedsInto;
    const dst = slotInfo(f.round, f.match, f.slot).pos;
    const mid = src.clone().lerp(dst, 0.5);
    mid.x *= 0.78; mid.z *= 0.78;
    mid.y += 0.7;
    return { curve: new THREE.QuadraticBezierCurve3(src, mid, dst), dst, f };
  }

  function ensureBeam(round, match, lit) {
    const key = `${round.id}:${match.id}`;
    if (beams.has(key)) return beams.get(key);
    const data = beamCurve(round, match);
    if (!data) return null;
    const pts = data.curve.getPoints(56);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: T.beam, transparent: true, opacity: 0.0 });
    const line = new THREE.Line(geo, mat);
    geo.setDrawRange(0, lit ? pts.length : 0);
    beamGroup.add(line);
    const beam = { key, line, mat, total: pts.length, draw: lit ? 1 : 0, target: 1 };
    if (lit) mat.opacity = 0.42;
    beams.set(key, beam);
    return beam;
  }

  function playAdvance(round, match) {
    const beam = ensureBeam(round, match, false);
    if (beam) { beam.draw = 0; beam.target = 1; beam.mat.opacity = 0.0; }

    const cv = beamCurve(round, match);
    if (!cv) return;
    // the card arriving in the next ring travels in along the beam
    const targetKey = `${cv.f.round}:${cv.f.match}:${cv.f.slot}`;
    const card = cards.get(targetKey);
    if (card) {
      card.travel = {
        curve: cv.curve, t: 0, dur: 1.15, delay: 0.35,
        fromRotY: slotInfo(round.id, match.id, winnerSlotOf(match)).rotY,
        toRotY: card.baseRotY,
      };
      card.faceMat.opacity = 0;
      card.frameMat.opacity = 0;
    }
  }

  function disposeCard(card) {
    ringGroups[card.roundIndex].remove(card.group);
    const idx = pickables.indexOf(card.face);
    if (idx >= 0) pickables.splice(idx, 1);
    card.texture.dispose();
    card.faceMat.dispose();
    card.frameMat.dispose();
    card.haloMat.dispose();
    card.face.geometry.dispose();
    card.frame.geometry.dispose();
    card.halo.geometry.dispose();
  }

  // ---- interaction ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let dragging = false, lastX = 0, moved = 0;
  let rotCurrent = 0, rotTarget = 0, spinVel = 0, flingVel = 0;
  let lastInteract = performance.now();
  let hoveredKey = null, selectedKey = null;

  const markInteract = () => (lastInteract = performance.now());

  function setPointer(e) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pick() {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    for (const h of hits) {
      const key = h.object.userData.key;
      const card = cards.get(key);
      if (card && card.state !== "placeholder" && card.state !== "eliminated") return key;
    }
    // allow eliminated too (just not placeholders) on a second pass
    for (const h of hits) {
      const key = h.object.userData.key;
      const card = cards.get(key);
      if (card && card.state !== "placeholder") return key;
    }
    return null;
  }

  function emitHover(key) {
    if (onHover) onHover(key ? matchInfo(key) : null);
  }
  function matchInfo(key) {
    const [roundId, matchId, slot] = key.split(":");
    const round = dataRef.rounds.find((r) => r.id === roundId);
    const match = round.matches.find((m) => m.id === matchId);
    return { round, match, slot, key };
  }

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; moved = 0; lastX = e.clientX; spinVel = 0; flingVel = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("grabbing");
    markInteract();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      moved += Math.abs(dx);
      rotTarget += dx * 0.0055;
      flingVel = dx * 0.0055;
      markInteract();
    } else {
      setPointer(e);
      const key = pick();
      if (key !== hoveredKey) {
        hoveredKey = key;
        canvas.classList.toggle("pointing", Boolean(key));
        if (!selectedKey) emitHover(key);
      }
    }
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove("grabbing");
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (moved < 6) {
      setPointer(e);
      const key = pick();
      selectedKey = key;
      emitHover(key);
      if (onSelect) onSelect(key ? matchInfo(key) : null);
    } else {
      spinVel = flingVel; // throw
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (!dragging && !selectedKey && hoveredKey) { hoveredKey = null; emitHover(null); canvas.classList.remove("pointing"); }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    rotTarget += e.deltaY * 0.0016;
    markInteract();
  }, { passive: false });

  function clearSelection() {
    selectedKey = null;
    emitHover(hoveredKey);
    if (onSelect) onSelect(null);
  }

  // ---- round focus ----
  // The camera never pans or dollies — the stack only spins on its axis.
  // Selecting a round just highlights that ring and dims the others.
  function focusRound(r) {
    highlightRound = r;
    markInteract();
  }

  // The "current" round (auto, advances as rounds finish) glows its guide ring.
  function setCurrentRound(r) {
    currentRound = r;
    applyGuideColors();
  }
  function applyGuideColors() {
    guideMats.forEach((m, i) => {
      const on = i === currentRound;
      m.color.setHex(on ? T.guideOn : T.guide);
      m.opacity = on ? Math.max(0.95, T.guideOpacity) : T.guideOpacity;
    });
  }

  // Fog is tuned for the desktop camera; scale it with the responsive pull-back
  // so distant cards/trophy don't disappear when the camera moves back on mobile.
  function applyFog() {
    const w = camera._widen || 1;
    scene.fog.near = T.fogNear * w;
    scene.fog.far = T.fogFar * w;
  }

  // ---- theme ----
  function setTheme(name) {
    T = THEMES[name] || THEMES.light;
    scene.fog.color.setHex(T.bg);
    applyFog();
    ambient.color.setHex(T.ambient);
    ambient.intensity = T.ambientI;
    rim.intensity = T.rimI;
    trophy.userData.gemMat.emissiveIntensity = T.gemEmissive;
    trophy.userData.glowMat.opacity = T.glow;
    applyGuideColors();
    for (const beam of beams.values()) beam.mat.color.setHex(T.beam);
    for (const card of cards.values()) {
      card.frameMat.color.setHex(frameColorFor(card.state));
      if (card.model) redraw(card);
    }
  }

  // ---- resize ----
  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // pull back on portrait / narrow screens so the whole stack stays in frame
    const a = camera.aspect;
    const widen = a < 1 ? 1 + (1 / a - 1) * 0.4 : 1;
    camera._widen = Math.min(1.7, Math.max(1, widen));
    applyFog();
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  // ---- loop ----
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    // spin: drag inertia only, eased toward target. No idle auto-rotation, so the
    // stack stays where the user leaves it (and starts on today's match).
    if (!dragging) {
      rotTarget += spinVel;
      spinVel *= 0.94;
      if (Math.abs(spinVel) < 1e-4) spinVel = 0;
    }
    rotCurrent += (rotTarget - rotCurrent) * 0.09;
    spinGroup.rotation.y = rotCurrent;

    // camera ease + responsive widen
    camState.dist += (camTarget.dist * (camera._widen || 1) - camState.dist) * 0.06;
    camState.height += (camTarget.height - camState.height) * 0.06;
    camState.lookY += (camTarget.lookY - camState.lookY) * 0.06;
    camera.position.set(0, camState.height, camState.dist);
    camera.lookAt(0, camState.lookY, 0);

    // trophy idle motion
    if (!reduce) {
      trophy.rotation.y += dt * 0.5;
      trophy.children.forEach((c) => { if (c.userData.halo) c.rotation.z += dt * 0.8; });
      trophy.position.y = ringHeight(4) + 1.7 + Math.sin(now * 0.0011) * 0.12;
    }
    const glowPulse = 0.6 + Math.sin(now * 0.002) * 0.12;
    core.intensity = (1.4 * glowPulse + 0.4) * T.coreI;

    // current round's guide ring breathes gently
    if (currentRound != null && guideMats[currentRound]) {
      guideMats[currentRound].opacity = Math.max(0.9, T.guideOpacity) + Math.sin(now * 0.003) * 0.1;
    }

    // per-card state animation
    const livePulse = reduce ? 0.5 : 0.5 + Math.sin(now * 0.005) * 0.5;
    for (const card of cards.values()) {
      // travel (advance animation)
      if (card.travel) {
        const tr = card.travel;
        if (tr.delay > 0) { tr.delay -= dt; }
        else {
          tr.t = Math.min(1, tr.t + dt / tr.dur);
          const e = easeInOut(tr.t);
          const p = tr.curve.getPoint(e);
          card.group.position.copy(p);
          card.group.rotation.y = tr.fromRotY + (tr.toRotY - tr.fromRotY) * e;
          const fade = Math.min(1, tr.t * 2);
          card.faceMat.opacity = fade * card.baseOpacity;
          card.frameMat.opacity = fade * card.baseOpacity;
          const sc = 0.7 + 0.3 * e;
          card.group.scale.setScalar(sc);
          if (tr.t >= 1) { card.travel = null; card.group.scale.setScalar(1); }
        }
      }

      // hover lift
      const wantHover = (hoveredKey === card.key || selectedKey === card.key) ? 1 : 0;
      card.hover += (wantHover - card.hover) * 0.18;

      // dim for round focus
      const wantDim = highlightRound == null || highlightRound === card.roundIndex ? 1 : 0.26;
      card.dim += (wantDim - card.dim) * 0.08;

      if (!card.travel) {
        const sinkY = -0.3 * card.sink;
        const off = card.outward.clone().multiplyScalar(0.42 * card.hover);
        card.group.position.set(
          card.base.x + off.x,
          card.base.y + off.y + sinkY,
          card.base.z + off.z
        );
        // live cards sit a touch larger so the flag reads bigger at the front
        const liveBump = card.state === "live" ? (reduce ? 0.09 : 0.08 + 0.02 * livePulse) : 0;
        card.group.scale.setScalar(1 + 0.08 * card.hover + liveBump);
        const op = card.baseOpacity * card.dim;
        card.faceMat.opacity = op;
        card.frameMat.opacity = op * 0.95;
      }

      // emissive: live pulse + hover glow + winner steady glow
      let emis = 0;
      if (card.state === "live") emis = 0.35 + livePulse * 0.5;
      else if (card.state === "winner") emis = 0.12;
      emis += card.hover * 0.25;
      card.faceMat.emissiveIntensity = emis * 0.6;
      card.frameMat.emissiveIntensity = card.state === "live" ? 0.6 + livePulse * 0.8 : card.state === "winner" ? 0.5 : card.hover * 0.4;

      // live halo: thick pulsing gold glow behind the card (steady under reduce)
      if (card.state === "live") {
        card.halo.visible = true;
        card.haloMat.opacity = (reduce ? 0.28 : 0.18 + livePulse * 0.3) * card.dim * (T.liveHalo || 1);
      } else if (card.halo.visible) {
        card.halo.visible = false;
      }
    }

    // beam draw-in
    for (const beam of beams.values()) {
      if (beam.draw < beam.target) {
        beam.draw = Math.min(beam.target, beam.draw + dt / 0.7);
        beam.line.geometry.setDrawRange(0, Math.floor(beam.total * beam.draw));
        beam.mat.opacity = 0.42 * beam.draw;
      }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  setTheme(T.name); // sync trophy / guides to the starting theme
  resize();
  tick();

  return {
    setData, focusRound, setCurrentRound, setTheme, clearSelection, resize, faceLiveMatch,
    get selected() { return selectedKey; },
  };
}

// ----------------------------------------------------------------------------
// Trophy — modelled here from primitives: a malachite base, a slim gold column
// that flares upward, holding a globe aloft. The whole thing is scaled to sit
// at the core of the rings.
// ----------------------------------------------------------------------------
function buildTrophy() {
  const g = new THREE.Group();
  const gemMat = new THREE.MeshStandardMaterial({ color: 0xeac983, metalness: 0.95, roughness: 0.24, emissive: 0xd4af6a, emissiveIntensity: 0.35 });

  // Malachite base — two dark-green banded discs.
  const malachite = new THREE.MeshStandardMaterial({ color: 0x1f5b3a, metalness: 0.55, roughness: 0.4, emissive: 0x0b2a1a, emissiveIntensity: 0.25 });
  const base1 = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.56, 0.16, 56), malachite);
  base1.position.y = -1.34;
  const base2 = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.12, 56), malachite);
  base2.position.y = -1.2;
  g.add(base1, base2);

  // Gold body — a lathe silhouette: narrow twisting stem rising and flaring out.
  const profile = [
    [0.30, -1.12], [0.16, -1.0], [0.125, -0.78], [0.12, -0.5],
    [0.135, -0.2], [0.17, 0.12], [0.25, 0.45], [0.35, 0.74],
    [0.4, 0.96], [0.37, 1.08], [0.3, 1.16],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 72), gemMat);
  g.add(body);

  // Collar where the body meets the globe.
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.12, 40), gemMat);
  collar.position.y = 1.16;
  g.add(collar);

  // The globe held up top, with a faint graticule so it reads as the Earth.
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.44, 48, 36), gemMat);
  globe.position.y = 1.62;
  g.add(globe);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xab7d34, metalness: 0.9, roughness: 0.45, emissive: 0x6e4f20, emissiveIntensity: 0.2 });
  for (let i = 0; i < 3; i++) {
    const meridian = new THREE.Mesh(new THREE.TorusGeometry(0.445, 0.01, 8, 64), lineMat);
    meridian.rotation.y = (i / 3) * Math.PI;
    meridian.position.y = 1.62;
    g.add(meridian);
  }
  const equator = new THREE.Mesh(new THREE.TorusGeometry(0.445, 0.012, 8, 64), lineMat);
  equator.rotation.x = Math.PI / 2;
  equator.position.y = 1.62;
  g.add(equator);

  g.scale.setScalar(0.92);

  // soft bloom sprite behind the trophy
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(212,175,106,0.7)");
  grd.addColorStop(0.4, "rgba(212,175,106,0.22)");
  grd.addColorStop(1, "rgba(212,175,106,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const glowMat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(6, 6, 1);
  glow.position.y = 0.4;
  g.add(glow);

  g.userData.gemMat = gemMat;
  g.userData.glowMat = glowMat;
  return g;
}
