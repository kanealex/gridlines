import {
  BOARD, DIFFICULTIES, makePuzzle, mst, createGA, prune, bestNetwork, networkLength,
  savedPercent, localDateKey, puzzleNumber,
} from "./core.js";
import { getLevel, starsFor, LEVEL_COUNT } from "./story.js";

const $ = (id) => document.getElementById(id);
const board = $("board");
const ctx = board.getContext("2d");
const chart = $("chart");
const chartCtx = chart.getContext("2d");

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

// Daily ranks, by share of the best known saving.
const RANKS = [
  [0.995, "Optimal"],
  [0.95, "Grid master"],
  [0.85, "Chief engineer"],
  [0.7, "Engineer"],
  [0.5, "Lineworker"],
  [0.25, "Apprentice"],
  [-Infinity, "Trainee"],
];

const state = {
  mode: "daily", // daily | story | versus
  puzzle: null,
  junctions: [],
  undo: [],
  phase: "play", // play | fighting | done
  best: null, // { junctions, length } best known network (daily)
  algo: null, // { junctions, length, history } the algorithm's result (versus)
  live: null, // the algorithm's current best while it runs
  level: null, // current story level
  storyResult: null, // { stars, saved } after pressing Submit in story mode
  difficulty: store.get("fta:difficulty", "normal"),
  view: "other",
  drag: null,
};

// Setup ----------------------------------------------------------------------

function reset(puzzle, junctions = []) {
  state.puzzle = puzzle;
  state.junctions = junctions;
  state.undo = [];
  state.phase = "play";
  state.best = null;
  state.algo = null;
  state.live = null;
  state.view = "other";
  state.storyResult = null;
}

function loadDaily() {
  state.mode = "daily";
  const key = localDateKey();
  const saved = store.get("fta:daily:" + key, null);
  reset(makePuzzle(key), saved?.junctions ?? []);
  if (saved?.done) {
    state.best = bestFor(state.puzzle);
    state.phase = "done";
    recordDaily();
  }
  render();
}

function loadStory(index) {
  const progress = storyProgress();
  if (index === undefined) index = Math.min(progress.current, LEVEL_COUNT - 1);
  state.mode = "story";
  state.level = getLevel(index);
  progress.current = index;
  store.set("fta:story", progress);
  reset(state.level.puzzle, store.get(`fta:story:${index}`, []));
  render();
}

function loadVersus() {
  state.mode = "versus";
  reset(makePuzzle("versus:" + Math.random().toString(36).slice(2)));
  render();
}

function load(mode) {
  store.set("fta:mode", mode);
  if (mode === "daily") loadDaily();
  else if (mode === "story") loadStory();
  else loadVersus();
}

function saveProgress() {
  if (state.mode === "daily") {
    store.set("fta:daily:" + state.puzzle.key, { junctions: state.junctions, done: state.phase !== "play" });
  } else if (state.mode === "story") {
    store.set(`fta:story:${state.level.index}`, state.junctions);
  }
}

// Story levels are only checked when you press Submit.
function submitStory() {
  const stars = starsFor(state.level, yourLength());
  state.storyResult = { stars, saved: pct(yourLength()) };
  if (stars > 0) {
    const progress = storyProgress();
    const i = state.level.index;
    if (stars > (progress.stars[i] ?? 0)) {
      progress.stars[i] = stars;
      store.set("fta:story", progress);
    }
  }
  render();
}

function storyProgress() {
  return store.get("fta:story", { current: 0, stars: {} });
}

// Scores ---------------------------------------------------------------------

function yourLength() { return networkLength(state.puzzle.towns, state.junctions); }
function pct(length) { return savedPercent(state.puzzle.base, length); }
const fmtPct = (p) => (Math.abs(p) < 0.005 ? "0.00" : p.toFixed(2)) + "%";
const describe = (p) => (p < -0.005 ? `${fmtPct(-p)} longer` : `${fmtPct(p)} shorter`);
const fmtLen = (l) => l.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";
const starText = (n, of = 3) => "★".repeat(n) + `<span class="off">${"★".repeat(of - n)}</span>`;

// The best known network for the daily puzzle. If the player beat it, theirs is.
function bestFor(puzzle) {
  const best = bestNetwork(puzzle);
  const yours = yourLength();
  return yours < best.length ? { junctions: prune(puzzle.towns, state.junctions), length: yours } : best;
}

// Share of the best known saving, 0..1.
function shareOfBest() {
  const saving = state.puzzle.base - yourLength();
  const bestSaving = state.puzzle.base - state.best.length;
  return bestSaving > 0 ? saving / bestSaving : 1;
}
const rankFor = (share) => RANKS.find(([min]) => share >= min)[1];

// Daily ----------------------------------------------------------------------

function submitDaily() {
  if (state.phase !== "play") return;
  state.best = bestFor(state.puzzle);
  state.phase = "done";
  state.view = "other";
  saveProgress();
  recordDaily();
  render();
}

function recordDaily() {
  const s = store.get("fta:dailyStats", { played: 0, totalShare: 0, streak: 0, best: 0, last: null, bestRank: null });
  const key = state.puzzle.key;
  if (s.last === key) return;
  const share = Math.min(1, Math.max(0, shareOfBest()));
  const yesterday = localDateKey(new Date(Date.now() - 86400000));
  s.played++;
  s.totalShare += share;
  s.streak = s.last === yesterday ? s.streak + 1 : 1;
  s.best = Math.max(s.best, s.streak);
  const rankIndex = RANKS.findIndex(([min]) => share >= min);
  if (s.bestRank === null || rankIndex < s.bestRank) s.bestRank = rankIndex;
  s.last = key;
  store.set("fta:dailyStats", s);
}

// vs Algorithm ---------------------------------------------------------------

function finish(puzzle, ga) {
  const junctions = prune(puzzle.towns, ga.best.junctions);
  return { junctions, length: networkLength(puzzle.towns, junctions), history: ga.history.slice() };
}

function fight() {
  if (state.phase !== "play") return;
  state.phase = "fighting";
  state.view = "other";
  const puzzle = state.puzzle;
  const ga = createGA(puzzle, DIFFICULTIES[state.difficulty].settings);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stepMs = reduced ? 0 : Math.min(48, 2400 / ga.settings.generations);
  let last = performance.now();
  const snapshot = () => ({
    junctions: ga.best.junctions, length: ga.best.length, history: ga.history,
    generation: ga.generation, generations: ga.settings.generations,
  });
  state.live = snapshot();

  function tick(now) {
    if (state.puzzle !== puzzle) return; // switched puzzle mid-fight
    if (stepMs === 0) while (ga.step());
    else while (now - last >= stepMs && ga.step()) last += stepMs;
    state.live = snapshot();
    if (ga.done) {
      state.algo = finish(puzzle, ga);
      state.live = null;
      state.phase = "done";
      recordVersus();
      render();
      return;
    }
    render();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Shortest network wins. Compare at 0.1 km so a win is always visible in the numbers.
function versusGap() {
  const theirs = state.phase === "fighting" ? state.live.length : state.algo.length;
  return Math.round((theirs - yourLength()) * 10) / 10;
}

function recordVersus() {
  const s = store.get("fta:versusStats", {});
  const d = s[state.difficulty] ?? { played: 0, wins: 0 };
  d.played++;
  if (versusGap() > 0) d.wins++;
  s[state.difficulty] = d;
  store.set("fta:versusStats", s);
}

// Stats and levels -----------------------------------------------------------

function showStats() {
  const tiles = (items) => items.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
  const d = store.get("fta:dailyStats", { played: 0, totalShare: 0, streak: 0, best: 0, last: null, bestRank: null });
  const yesterday = localDateKey(new Date(Date.now() - 86400000));
  const streak = d.last === localDateKey() || d.last === yesterday ? d.streak : 0;
  $("dailyStats").innerHTML = tiles([
    [d.played, "Played"],
    [d.played ? Math.round((d.totalShare / d.played) * 100) + "%" : "–", "Avg of best"],
    [streak, "Streak"],
    [d.bestRank === null ? "–" : RANKS[d.bestRank][1].split(" ").pop(), "Top rank"],
  ]);
  const p = storyProgress();
  const stars = Object.values(p.stars).reduce((a, b) => a + b, 0);
  const cleared = Object.values(p.stars).filter((n) => n > 0).length;
  $("storyStats").innerHTML = tiles([[`${cleared}/${LEVEL_COUNT}`, "Levels"], [`${stars}/${LEVEL_COUNT * 3}`, "Stars"]]);
  const v = store.get("fta:versusStats", {});
  $("versusStats").innerHTML = tiles(Object.entries(DIFFICULTIES).map(([k, { label }]) => {
    const r = v[k] ?? { played: 0, wins: 0 };
    return [`${r.wins}/${r.played}`, label + " wins"];
  }));
  $("statsDialog").showModal();
}

function showLevels() {
  const p = storyProgress();
  const unlocked = (i) => i === 0 || (p.stars[i - 1] ?? 0) > 0;
  $("levelGrid").innerHTML = Array.from({ length: LEVEL_COUNT }, (_, i) => {
    const s = p.stars[i] ?? 0;
    const current = state.mode === "story" && state.level.index === i ? "current" : "";
    return `<button type="button" data-level="${i}" class="${current}"${unlocked(i) ? "" : " disabled"} aria-label="Level ${i + 1}, ${s} stars">${i + 1}<span class="stars">${starText(s)}</span></button>`;
  }).join("");
  $("levelsDialog").showModal();
}

$("levelGrid").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-level]");
  if (!b || b.disabled) return;
  $("levelsDialog").close();
  store.set("fta:mode", "story");
  loadStory(+b.dataset.level);
});

// Drawing --------------------------------------------------------------------

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const name of ["line", "ghost", "accent", "algo", "win", "board", "faint", "border"]) {
    colors[name] = cs.getPropertyValue("--" + name).trim();
  }
}

function sizeCanvas(canvas, c) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

function drawNetwork(towns, junctions, { color, width, showJunctions, ghost }) {
  const scale = board.clientWidth / BOARD;
  const pts = towns.concat(junctions);
  const { edges, degree } = mst(pts);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [a, b] of edges) {
    ctx.moveTo(pts[a][0] * scale, pts[a][1] * scale);
    ctx.lineTo(pts[b][0] * scale, pts[b][1] * scale);
  }
  ctx.stroke();
  if (!showJunctions || ghost) return;
  for (let i = 0; i < junctions.length; i++) {
    const [x, y] = junctions[i];
    const useful = degree[towns.length + i] >= 3;
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = useful ? color : colors.board;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function drawTowns(towns) {
  const scale = board.clientWidth / BOARD;
  for (const [x, y] of towns) {
    const s = 7;
    ctx.fillStyle = colors.board;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(x * scale - s, y * scale - s, s * 2, s * 2, 3);
    ctx.fill();
    ctx.stroke();
  }
}

function otherNetwork() {
  if (state.mode === "daily") return state.best;
  return state.phase === "fighting" ? state.live : state.algo;
}

function drawBoard() {
  const rect = sizeCanvas(board, ctx);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const { puzzle, phase, view } = state;
  const towns = puzzle.towns;
  if (phase === "play") {
    drawNetwork(towns, state.junctions, { color: colors.accent, width: 2.5, showJunctions: true });
  } else {
    const other = otherNetwork();
    const otherColor = state.mode === "daily" ? colors.win : colors.algo;
    if (phase === "fighting" || view === "other") {
      drawNetwork(towns, state.junctions, { color: colors.ghost, width: 2, ghost: true });
      drawNetwork(towns, other.junctions, { color: otherColor, width: 2.5, showJunctions: true });
    } else {
      drawNetwork(towns, other.junctions, { color: colors.ghost, width: 2, ghost: true });
      drawNetwork(towns, state.junctions, { color: colors.accent, width: 2.5, showJunctions: true });
    }
  }
  drawTowns(towns);
}

function drawChart() {
  const rect = sizeCanvas(chart, chartCtx);
  const c = chartCtx;
  const { width: w, height: h } = rect;
  c.clearRect(0, 0, w, h);
  const run = state.phase === "fighting" ? state.live : state.algo;
  if (state.mode !== "versus" || !run) return;
  const total = DIFFICULTIES[state.difficulty].settings.generations;
  const series = run.history.map(pct);
  const you = pct(yourLength());
  const top = Math.max(you, ...series, 0.5) * 1.15;
  const pad = 4;
  const X = (i) => pad + (i / total) * (w - pad * 2);
  const Y = (p) => h - pad - (Math.max(0, p) / top) * (h - pad * 2);

  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(pad, h - pad + 0.5);
  c.lineTo(w - pad, h - pad + 0.5);
  c.stroke();

  c.setLineDash([5, 4]);
  c.strokeStyle = colors.accent;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(pad, Y(you));
  c.lineTo(w - pad, Y(you));
  c.stroke();
  c.setLineDash([]);

  c.strokeStyle = colors.algo;
  c.lineWidth = 2;
  c.lineJoin = "round";
  c.beginPath();
  series.forEach((p, i) => (i ? c.lineTo(X(i), Y(p)) : c.moveTo(X(i), Y(p))));
  c.stroke();

  c.font = "600 11px system-ui, sans-serif";
  c.fillStyle = colors.accent;
  c.textAlign = "right";
  c.fillText("You", w - pad, Math.max(12, Y(you) - 5));
  c.fillStyle = colors.faint;
  c.textAlign = "left";
  c.fillText("Algorithm, by generation", pad, 12);
}

// UI -------------------------------------------------------------------------

function render() {
  const { puzzle, phase, mode } = state;
  const you = yourLength();

  for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-selected", b.dataset.mode === mode);
  $("subtitle").textContent = mode === "daily"
    ? `Daily #${puzzleNumber(puzzle.key)} · ${new Date(puzzle.key + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`
    : mode === "story"
      ? `Story · Level ${state.level.index + 1} of ${LEVEL_COUNT}`
      : `vs Algorithm · ${puzzle.towns.length} towns`;

  $("scoreValue").textContent = fmtPct(Math.abs(pct(you)));
  $("scoreLabel").textContent = pct(you) < -0.005 ? "longer than the plain network" : "shorter than the plain network";
  $("scoreValue").style.color = pct(you) < -0.005 ? "var(--lose)" : state.junctions.length === 0 ? "var(--faint)" : "var(--accent)";
  $("scoreSide").innerHTML = `${fmtLen(you)} of cable<br>plain: ${fmtLen(puzzle.base)}`;

  renderStoryBar();
  renderVersusBar();

  board.classList.toggle("locked", phase !== "play");
  $("playControls").hidden = phase !== "play";
  $("undoBtn").disabled = state.undo.length === 0;
  $("clearBtn").disabled = state.junctions.length === 0;
  const primary = $("primaryBtn");
  if (mode === "daily") {
    primary.textContent = "Submit";
    primary.disabled = state.junctions.length === 0;
  } else if (mode === "story") {
    const passed = state.storyResult?.stars > 0;
    const last = state.level.index === LEVEL_COUNT - 1;
    primary.textContent = passed ? (last ? "Story complete" : "Next level →") : "Submit";
    primary.disabled = passed ? last : state.junctions.length === 0;
  } else {
    primary.textContent = "Fight the algorithm";
    primary.disabled = false;
  }

  const useless = state.junctions.length - prune(puzzle.towns, state.junctions).length;
  const otherName = mode === "daily" ? "best known" : "algorithm's";
  $("hint").textContent = phase === "fighting"
    ? `Generation ${state.live.generation} of ${state.live.generations}. The algorithm is evolving…`
    : phase === "done"
      ? (state.view === "you"
        ? `Showing your network. The ${otherName} network is in grey.`
        : `Showing the ${otherName} network. Yours is in grey.`)
      : state.junctions.length === 0
        ? (mode === "story" && state.level.tip) || "Tap to add a junction. Drag to move it. Tap it again to remove it."
        : useless > 0
          ? "Hollow junctions aren't helping: they need three or more lines."
          : "Drag junctions to fine-tune. Lines meeting at 120° is the sweet spot.";

  renderResult();
  drawBoard();
  drawChart();
}

function renderStoryBar() {
  const show = state.mode === "story";
  $("storyBar").hidden = !show;
  $("storyBanner").hidden = true;
  if (!show) return;
  const level = state.level;
  const used = state.junctions.length;
  $("levelName").textContent = `${level.index + 1}. ${level.name}`;
  $("goalText").innerHTML = `Goal: save <b>${fmtPct(level.goalPercent)}</b> · junctions <b>${used}/${level.maxJunctions}</b>`;
  $("levelStars").innerHTML = starText(storyProgress().stars[level.index] ?? 0);
  const result = state.storyResult;
  if (!result) return;
  const banner = $("storyBanner");
  banner.hidden = false;
  banner.classList.toggle("fail", result.stars === 0);
  if (result.stars === 0) {
    banner.innerHTML = `<span><b>Not yet.</b> Your network is ${describe(result.saved)} and the goal is ${fmtPct(level.goalPercent)} shorter. Adjust your junctions and submit again.</span>`;
    return;
  }
  const stars = result.stars;
  const last = level.index === LEVEL_COUNT - 1;
  const message = last
    ? "<b>Story complete.</b> That's every level. Go back for any stars you missed."
    : stars < 3
      ? `<b>Level complete.</b> Improve your network and submit again for ${3 - stars} more star${stars === 2 ? "" : "s"}, or move on.`
      : "<b>Perfect.</b> As good as the best known network.";
  banner.innerHTML = `<span>${message}</span><span class="stars">${starText(stars)}</span>`;
}

function renderVersusBar() {
  const show = state.mode === "versus";
  $("versusBar").hidden = !show;
  if (!show) return;
  for (const b of $("difficulty").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", b.dataset.difficulty === state.difficulty);
    b.disabled = state.phase === "fighting";
  }
  $("newPuzzleBtn").disabled = state.phase === "fighting";
}

function renderResult() {
  const { phase, mode } = state;
  const box = $("result");
  box.hidden = phase === "play" || mode === "story";
  if (box.hidden) return;
  const yourLen = yourLength();
  const other = otherNetwork();
  const title = $("resultTitle");
  const otherSide = $("otherSide");
  const youSide = box.querySelector(".side.you");
  otherSide.classList.toggle("best", mode === "daily");
  $("otherWho").textContent = mode === "daily" ? "Best known" : `Algorithm (${DIFFICULTIES[state.difficulty].label})`;
  $("viewOther").textContent = mode === "daily" ? "Best known" : "Algorithm";
  $("youLen").textContent = fmtLen(yourLen);
  $("otherLen").textContent = fmtLen(other.length);
  $("youPct").textContent = describe(pct(yourLen));
  $("otherPct").textContent = describe(pct(other.length));
  $("chart").hidden = mode !== "versus";
  $("meter").hidden = mode !== "daily";
  $("bestKnown").textContent = "";

  if (mode === "daily") {
    const share = shareOfBest();
    title.textContent = rankFor(share);
    title.className = share >= 0.7 ? "win" : "";
    $("resultSub").textContent = share >= 0.995
      ? "You matched the best known network."
      : `You found ${Math.max(0, Math.round(share * 100))}% of the best known saving.`;
    $("meterFill").style.width = Math.max(0, Math.min(100, share * 100)) + "%";
    youSide.classList.remove("lead");
    otherSide.classList.remove("lead");
  } else {
    const gap = versusGap();
    youSide.classList.toggle("lead", gap > 0);
    otherSide.classList.toggle("lead", gap < 0);
    $("resultSub").textContent = "";
    if (phase === "fighting") {
      title.textContent = "Fighting…";
      title.className = "";
    } else {
      const by = fmtLen(Math.abs(gap));
      if (gap > 0) { title.textContent = `You win by ${by}`; title.className = "win"; }
      else if (gap === 0) { title.textContent = "A dead heat"; title.className = ""; }
      else { title.textContent = `The algorithm wins by ${by}`; title.className = "lose"; }
    }
  }

  const done = phase === "done";
  $("viewYou").disabled = !done;
  $("viewOther").disabled = !done;
  $("viewYou").setAttribute("aria-pressed", state.view === "you");
  $("viewOther").setAttribute("aria-pressed", state.view === "other");
  $("shareBtn").disabled = !done;
  $("againBtn").hidden = mode !== "versus";
  $("againBtn").disabled = !done;
  updateCountdown();
}

function updateCountdown() {
  const el = $("nextDaily");
  if (state.mode !== "daily" || state.phase !== "done") { el.textContent = ""; return; }
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const mins = Math.max(1, Math.ceil((tomorrow - now) / 60000));
  el.textContent = `Next puzzle in ${Math.floor(mins / 60)}h ${mins % 60}m. Try Story or vs Algorithm in the meantime.`;
}

function shareText() {
  const you = pct(yourLength());
  if (state.mode === "daily") {
    const share = Math.max(0, Math.min(1, shareOfBest()));
    const filled = Math.round(share * 10);
    return [
      `Steiner Point #${puzzleNumber(state.puzzle.key)}`,
      `${rankFor(shareOfBest())}: ${Math.round(share * 100)}% of the best network`,
      "\u{1F7E9}".repeat(filled) + "⬜".repeat(10 - filled),
      `${fmtLen(yourLength())} (${describe(you)})`,
      "https://steiner.kanealex.com",
    ].join("\n");
  }
  const won = versusGap() > 0;
  return [
    `Steiner Point: vs ${DIFFICULTIES[state.difficulty].label}`,
    `\u{1F9D1} Me: ${fmtLen(yourLength())} (${describe(you)})`,
    `\u{1F9EC} Algorithm: ${fmtLen(state.algo.length)} (${describe(pct(state.algo.length))})`,
    won ? "\u{1F3C6} Beat the algorithm" : "\u{1F916} The algorithm won",
    "https://steiner.kanealex.com",
  ].join("\n");
}

async function share() {
  const text = shareText();
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't copy the result");
  }
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

// Input ----------------------------------------------------------------------

function boardPoint(e) {
  const rect = board.getBoundingClientRect();
  const k = BOARD / rect.width;
  const clamp = (v) => Math.min(BOARD, Math.max(0, v));
  return [clamp((e.clientX - rect.left) * k), clamp((e.clientY - rect.top) * k)];
}

function pushUndo() {
  state.undo.push(state.junctions.map((p) => p.slice()));
  if (state.undo.length > 100) state.undo.shift();
}

board.addEventListener("pointerdown", (e) => {
  if (state.phase !== "play" || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  const p = boardPoint(e);
  const k = BOARD / board.clientWidth;
  const hit = (e.pointerType === "mouse" ? 14 : 24) * k;
  let index = -1;
  let bestD = hit;
  state.junctions.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) { bestD = d; index = i; }
  });
  state.storyResult = null;
  let created = false;
  if (index < 0) {
    const max = state.mode === "story" ? state.level.maxJunctions : Infinity;
    if (state.junctions.length >= max) {
      toast(`This level allows ${max} junction${max === 1 ? "" : "s"}. Move or remove one.`);
      return;
    }
    pushUndo();
    state.junctions.push(p);
    index = state.junctions.length - 1;
    created = true;
  } else {
    pushUndo();
  }
  state.drag = { id: e.pointerId, index, created, x: e.clientX, y: e.clientY, moved: false };
  board.setPointerCapture(e.pointerId);
  render();
});

board.addEventListener("pointermove", (e) => {
  const d = state.drag;
  if (!d || d.id !== e.pointerId) return;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
  d.moved = true;
  state.junctions[d.index] = boardPoint(e);
  render();
});

function endDrag(e) {
  const d = state.drag;
  if (!d || d.id !== e.pointerId) return;
  state.drag = null;
  if (!d.moved && !d.created) state.junctions.splice(d.index, 1); // tap removes
  else if (!d.moved && d.created && e.type === "pointercancel") state.junctions.pop();
  saveProgress();
  render();
}
board.addEventListener("pointerup", endDrag);
board.addEventListener("pointercancel", endDrag);
board.addEventListener("contextmenu", (e) => e.preventDefault());

$("undoBtn").onclick = () => {
  if (!state.undo.length) return;
  state.junctions = state.undo.pop();
  state.storyResult = null;
  saveProgress();
  render();
};
$("clearBtn").onclick = () => {
  if (!state.junctions.length) return;
  pushUndo();
  state.junctions = [];
  state.storyResult = null;
  saveProgress();
  render();
};
$("primaryBtn").onclick = () => {
  if (state.mode === "daily") submitDaily();
  else if (state.mode === "story") {
    if (state.storyResult?.stars > 0) loadStory(state.level.index + 1);
    else submitStory();
  }
  else fight();
};
$("shareBtn").onclick = share;
$("againBtn").onclick = loadVersus;
$("newPuzzleBtn").onclick = loadVersus;
$("levelsBtn").onclick = showLevels;
$("difficulty").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-difficulty]");
  if (!b || state.phase === "fighting") return;
  state.difficulty = b.dataset.difficulty;
  store.set("fta:difficulty", state.difficulty);
  if (state.phase === "done") loadVersus(); // a new opponent gets a fresh puzzle
  else render();
});
$("viewYou").onclick = () => { state.view = "you"; render(); };
$("viewOther").onclick = () => { state.view = "other"; render(); };
for (const b of document.querySelectorAll(".modes button")) {
  b.onclick = () => { if (state.mode !== b.dataset.mode) load(b.dataset.mode); };
}
$("statsBtn").onclick = showStats;

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && state.phase === "play") { e.preventDefault(); $("undoBtn").click(); }
});

// Boot -----------------------------------------------------------------------

$("year").textContent = new Date().getFullYear();

readColors();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); render(); });
new ResizeObserver(() => state.puzzle && render()).observe(board);
setInterval(() => {
  // Roll over to the new daily puzzle at midnight if the page is left open.
  if (state.mode === "daily" && state.puzzle.key !== localDateKey()) loadDaily();
  else updateCountdown();
}, 30000);

const hashMode = location.hash.slice(1);
load(["daily", "story", "versus"].includes(hashMode) ? hashMode : store.get("fta:mode", "daily"));
store.set("fta:seenHelp", true); // the how-to-play page skips straight here from now on
