import {
  BOARD, GA_SETTINGS, makePuzzle, mst, createGA, prune, polish, networkLength,
  savedPercent, localDateKey, puzzleNumber,
} from "./core.js";

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

const state = {
  mode: "daily",
  puzzle: null,
  junctions: [],
  undo: [],
  phase: "play", // play | fighting | done
  algo: null, // { junctions, length, history }
  live: null, // the algorithm's current best while it runs
  view: "algo",
  drag: null,
};

// Setup ----------------------------------------------------------------------

function dailyKey() { return localDateKey(); }

function loadDaily() {
  state.mode = "daily";
  const key = dailyKey();
  state.puzzle = makePuzzle(key);
  const saved = store.get("fta:daily:" + key, null);
  state.junctions = saved?.junctions ?? [];
  state.undo = [];
  state.algo = null;
  state.phase = "play";
  if (saved?.done) {
    state.algo = solveInstantly(state.puzzle);
    state.phase = "done";
    state.view = "algo";
    recordDaily(); // no-op unless the page closed mid-fight
  }
  render();
}

function loadPractice() {
  state.mode = "practice";
  const key = "practice:" + Math.random().toString(36).slice(2);
  state.puzzle = makePuzzle(key);
  state.junctions = [];
  state.undo = [];
  state.algo = null;
  state.phase = "play";
  render();
}

function saveDaily(done = false) {
  if (state.mode !== "daily") return;
  store.set("fta:daily:" + state.puzzle.key, { junctions: state.junctions, done });
}

// Scores ---------------------------------------------------------------------

function yourLength() { return networkLength(state.puzzle.towns, state.junctions); }
function pct(length) { return savedPercent(state.puzzle.base, length); }
const fmtPct = (p) => (Math.abs(p) < 0.005 ? "0.00" : p.toFixed(2)) + "%";
const describe = (p) => (p < -0.005 ? `${fmtPct(-p)} longer` : `${fmtPct(p)} shorter`);
const fmtLen = (l) => l.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";

function bestKnown() {
  const { puzzle, algo } = state;
  const candidates = [puzzle.bestKnown, yourLength()];
  if (algo) candidates.push(algo.length, networkLength(puzzle.towns, polish(puzzle.towns, algo.junctions)));
  return Math.min(...candidates);
}

// Algorithm ------------------------------------------------------------------

function solveInstantly(puzzle) {
  const ga = createGA(puzzle);
  while (ga.step());
  return finish(puzzle, ga);
}

function finish(puzzle, ga) {
  const junctions = prune(puzzle.towns, ga.best.junctions);
  return { junctions, length: networkLength(puzzle.towns, junctions), history: ga.history.slice() };
}

function fight() {
  if (state.phase !== "play") return;
  state.phase = "fighting";
  state.view = "algo";
  saveDaily(true); // locks in today's answer even if the page closes mid-fight
  const puzzle = state.puzzle;
  const ga = createGA(puzzle);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stepMs = reduced ? 0 : 2400 / ga.settings.generations;
  let last = performance.now();
  state.live = { junctions: ga.best.junctions, length: ga.best.length, history: ga.history, generation: 0 };

  function tick(now) {
    if (state.puzzle !== puzzle) return; // switched puzzle mid-fight
    if (stepMs === 0) while (ga.step());
    else while (now - last >= stepMs && ga.step()) last += stepMs;
    state.live = { junctions: ga.best.junctions, length: ga.best.length, history: ga.history, generation: ga.generation };
    if (ga.done) {
      state.algo = finish(puzzle, ga);
      state.live = null;
      state.phase = "done";
      if (state.mode === "daily") recordDaily();
      render();
      return;
    }
    render();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Stats ----------------------------------------------------------------------

function recordDaily() {
  const s = store.get("fta:stats", { played: 0, wins: 0, streak: 0, best: 0, last: null, lastWin: null });
  const key = state.puzzle.key;
  if (s.last === key) return;
  const won = Math.round((state.algo.length - yourLength()) * 10) / 10 > 0;
  const yesterday = localDateKey(new Date(Date.now() - 86400000));
  s.played++;
  if (won) {
    s.wins++;
    s.streak = s.lastWin === yesterday ? s.streak + 1 : 1;
    s.best = Math.max(s.best, s.streak);
    s.lastWin = key;
  } else {
    s.streak = 0;
  }
  s.last = key;
  store.set("fta:stats", s);
}

function showStats() {
  const s = store.get("fta:stats", { played: 0, wins: 0, streak: 0, best: 0, lastWin: null });
  const today = dailyKey();
  const yesterday = localDateKey(new Date(Date.now() - 86400000));
  const streak = s.lastWin === today || s.lastWin === yesterday ? s.streak : 0;
  const winRate = s.played ? Math.round((s.wins / s.played) * 100) : 0;
  $("stats").innerHTML = [
    [s.played, "Played"], [winRate + "%", "Win rate"], [streak, "Win streak"], [s.best, "Best streak"],
  ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
  $("statsDialog").showModal();
}

// Drawing --------------------------------------------------------------------

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const name of ["line", "ghost", "accent", "algo", "board", "faint", "border"]) {
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

function drawBoard() {
  const rect = sizeCanvas(board, ctx);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const { puzzle, phase, view } = state;
  const towns = puzzle.towns;
  if (phase === "play") {
    drawNetwork(towns, state.junctions, { color: colors.accent, width: 2.5, showJunctions: true });
  } else {
    const algo = phase === "fighting" ? state.live : state.algo;
    const showAlgo = phase === "fighting" || view === "algo";
    if (showAlgo) {
      drawNetwork(towns, state.junctions, { color: colors.ghost, width: 2, ghost: true });
      drawNetwork(towns, algo.junctions, { color: colors.algo, width: 2.5, showJunctions: true });
    } else {
      drawNetwork(towns, algo.junctions, { color: colors.ghost, width: 2, ghost: true });
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
  if (!run) return;
  const total = GA_SETTINGS.generations;
  const series = run.history.map(pct);
  const you = pct(yourLength());
  const top = Math.max(you, ...series, pct(state.algo?.length ?? Infinity), 0.5) * 1.15;
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

  $("modeDaily").setAttribute("aria-selected", mode === "daily");
  $("modePractice").setAttribute("aria-selected", mode === "practice");
  $("subtitle").textContent = mode === "daily"
    ? `Daily #${puzzleNumber(puzzle.key)} · ${new Date(puzzle.key + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`
    : `Practice · ${puzzle.towns.length} towns`;

  $("scoreValue").textContent = fmtPct(Math.abs(pct(you)));
  $("scoreValue").style.color = pct(you) < -0.005 ? "var(--lose)" : state.junctions.length === 0 ? "var(--faint)" : "var(--accent)";
  $("scoreLabel").textContent = pct(you) < -0.005 ? "longer than the plain network" : "shorter than the plain network";
  $("scoreSide").innerHTML = `${fmtLen(you)} of cable<br>Plain network ${fmtLen(puzzle.base)}`;

  board.classList.toggle("locked", phase !== "play");
  $("playControls").hidden = phase !== "play";
  $("undoBtn").disabled = state.undo.length === 0;
  $("clearBtn").disabled = state.junctions.length === 0;

  const useless = state.junctions.length - prune(puzzle.towns, state.junctions).length;
  $("hint").textContent = phase === "fighting"
    ? `Generation ${state.live.generation} of ${GA_SETTINGS.generations}. The algorithm is evolving…`
    : phase === "done"
      ? (state.view === "you" ? "Showing your network. The algorithm's is in grey." : "Showing the algorithm's network. Yours is in grey.")
      : state.junctions.length === 0
        ? "Tap to add a junction. Drag to move it. Tap it again to remove it."
        : useless > 0
          ? "Hollow junctions aren't helping: they need three or more lines."
          : "Drag junctions to fine-tune. Lines meeting at 120° is the sweet spot.";

  renderResult();
  drawBoard();
  drawChart();
}

function renderResult() {
  const { phase, algo, mode } = state;
  const box = $("result");
  box.hidden = phase === "play";
  if (phase === "play") return;
  const you = pct(yourLength());
  const title = $("resultTitle");
  const yourLen = yourLength();
  const theirLen = phase === "fighting" ? state.live.length : algo.length;
  $("youLen").textContent = fmtLen(yourLen);
  $("algoLen").textContent = fmtLen(theirLen);
  $("youPct").textContent = describe(pct(yourLen));
  $("algoPct").textContent = describe(pct(theirLen));
  // Shortest network wins. Compare rounded to 0.1 km so a "win" is always visible in the numbers.
  const gap = Math.round((theirLen - yourLen) * 10) / 10;
  box.querySelector(".side.you").classList.toggle("lead", gap > 0);
  box.querySelector(".side.algo").classList.toggle("lead", gap < 0);
  if (phase === "fighting") {
    title.textContent = "Fighting\u2026";
    title.className = "";
    $("bestKnown").textContent = "";
  } else {
    const by = fmtLen(Math.abs(gap));
    if (gap > 0) { title.textContent = `You win by ${by}`; title.className = "win"; }
    else if (gap === 0) { title.textContent = "A dead heat"; title.className = ""; }
    else { title.textContent = `The algorithm wins by ${by}`; title.className = "lose"; }
    const best = bestKnown();
    $("bestKnown").textContent = yourLen <= best + 1e-9
      ? `Shortest known network: ${fmtLen(best)}. That's yours.`
      : `Shortest known network for this puzzle: ${fmtLen(best)}`;
  }
  const done = phase === "done";
  $("viewYou").disabled = !done;
  $("viewAlgo").disabled = !done;
  $("viewYou").setAttribute("aria-pressed", state.view === "you");
  $("viewAlgo").setAttribute("aria-pressed", state.view === "algo");
  $("shareBtn").disabled = !done;
  $("nextBtn").hidden = mode !== "practice";
  $("nextBtn").disabled = !done;
  updateCountdown();
}

function updateCountdown() {
  const el = $("nextDaily");
  if (state.mode !== "daily" || state.phase !== "done") { el.textContent = ""; return; }
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const mins = Math.max(1, Math.ceil((tomorrow - now) / 60000));
  el.textContent = `Next puzzle in ${Math.floor(mins / 60)}h ${mins % 60}m. Try Practice in the meantime.`;
}

function shareText() {
  const you = pct(yourLength());
  const them = pct(state.algo.length);
  const won = Math.round((state.algo.length - yourLength()) * 10) / 10 > 0;
  const head = state.mode === "daily" ? `Fight the Algorithm #${puzzleNumber(state.puzzle.key)}` : "Fight the Algorithm (practice)";
  return [
    head,
    `\u{1F9D1} Me: ${fmtLen(yourLength())} (${describe(you)})`,
    `\u{1F9EC} Algorithm: ${fmtLen(state.algo.length)} (${describe(them)})`,
    won ? "\u{1F3C6} Beat the algorithm" : "\u{1F916} The algorithm won",
    "https://fight.kanealex.com",
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
    toast("Couldn't copy. Select and copy:\n" + text);
  }
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
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
  pushUndo();
  let created = false;
  if (index < 0) {
    state.junctions.push(p);
    index = state.junctions.length - 1;
    created = true;
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
  saveDaily();
  render();
}
board.addEventListener("pointerup", endDrag);
board.addEventListener("pointercancel", endDrag);
board.addEventListener("contextmenu", (e) => e.preventDefault());

$("undoBtn").onclick = () => {
  if (!state.undo.length) return;
  state.junctions = state.undo.pop();
  saveDaily();
  render();
};
$("clearBtn").onclick = () => {
  if (!state.junctions.length) return;
  pushUndo();
  state.junctions = [];
  saveDaily();
  render();
};
$("fightBtn").onclick = fight;
$("shareBtn").onclick = share;
$("nextBtn").onclick = loadPractice;
$("viewYou").onclick = () => { state.view = "you"; render(); };
$("viewAlgo").onclick = () => { state.view = "algo"; render(); };
$("modeDaily").onclick = () => { if (state.mode !== "daily") loadDaily(); };
$("modePractice").onclick = () => { if (state.mode !== "practice") loadPractice(); };
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
  if (state.mode === "daily" && state.phase !== "fighting" && state.puzzle.key !== dailyKey()) loadDaily();
  else updateCountdown();
}, 30000);

loadDaily();
store.set("fta:seenHelp", true); // the how-to-play page skips straight here from now on
