// Puzzle generation, scoring and the genetic algorithm. No DOM access, so the
// same code runs in the browser and in Node (see tools/tune.js).

export const BOARD = 1000; // Puzzles live on a 1000x1000 board, scaled to fit the screen.
export const LAUNCH = "2026-10-10"; // Puzzle #1.

// Seeded RNG ------------------------------------------------------------------

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: small, fast, and identical on every browser.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Dates -----------------------------------------------------------------------

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function puzzleNumber(dateKey) {
  const day = (key) => Date.UTC(...key.split("-").map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((day(dateKey) - day(LAUNCH)) / 86400000) + 1;
}

// Puzzles ---------------------------------------------------------------------

// Towns are spread out (minimum gap) so every puzzle is readable on a phone.
// Some random layouts barely improve with junctions, which makes a dull day.
// Re-roll (deterministically) until a decent saving is possible.
export const MIN_POTENTIAL = 2.5; // percent

// `count` fixes the number of towns (default: 8 to 12, chosen by the seed).
export function makePuzzle(seedKey, { count, minPotential = MIN_POTENTIAL } = {}) {
  let puzzle;
  for (let attempt = 0; attempt < 40; attempt++) {
    puzzle = layout(seedKey, hashString(`fta:${seedKey}:${attempt}`), count);
    const known = greedySteiner(puzzle.towns);
    puzzle.bestKnown = networkLength(puzzle.towns, known);
    if (savedPercent(puzzle.base, puzzle.bestKnown) >= minPotential) break;
  }
  return puzzle;
}

// A puzzle from a fixed set of towns (story mode's hand-made levels).
export function puzzleFromTowns(key, towns) {
  const known = greedySteiner(towns);
  return { key, seed: hashString("fta:" + key), towns, base: mst(towns).length, bestKnown: networkLength(towns, known) };
}

// The best network we can find: the greedy heuristic, or a long, strong GA
// run, whichever is shorter. Deterministic for a given puzzle.
export function bestNetwork(puzzle) {
  const greedy = greedySteiner(puzzle.towns);
  const ga = polish(puzzle.towns, runGA(puzzle, DIFFICULTIES.hard.settings).junctions);
  const g = networkLength(puzzle.towns, greedy);
  const h = networkLength(puzzle.towns, ga);
  return g <= h ? { junctions: greedy, length: g } : { junctions: ga, length: h };
}

function layout(seedKey, seed, fixedCount) {
  const rand = rng(seed);
  const randomCount = 8 + Math.floor(rand() * 5); // 8 to 12 towns
  const count = fixedCount ?? randomCount;
  const margin = 70;
  const minGap = 120;
  const towns = [];
  let tries = 0;
  while (towns.length < count && tries < 5000) {
    tries++;
    const p = [margin + rand() * (BOARD - 2 * margin), margin + rand() * (BOARD - 2 * margin)];
    if (towns.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= minGap)) towns.push(p);
  }
  return { key: seedKey, seed, towns, base: mst(towns).length };
}

// Scoring ---------------------------------------------------------------------

// Prim's algorithm, O(n^2). Returns total length, edges as index pairs, and
// each node's degree. Nodes are towns followed by junctions.
export function mst(points) {
  const n = points.length;
  const edges = [];
  const degree = new Array(n).fill(0);
  if (n < 2) return { length: 0, edges, degree };
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  best[0] = 0;
  let length = 0;
  for (let step = 0; step < n; step++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) {
      length += best[u];
      edges.push([from[u], u]);
      degree[u]++;
      degree[from[u]]++;
    }
    const [ux, uy] = points[u];
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = Math.hypot(points[v][0] - ux, points[v][1] - uy);
      if (d < best[v]) {
        best[v] = d;
        from[v] = u;
      }
    }
  }
  return { length, edges, degree };
}

export function networkLength(towns, junctions) {
  return mst(towns.concat(junctions)).length;
}

// Junctions joined to fewer than three lines can never shorten the network.
// Dropping them repeatedly never makes it longer.
export function prune(towns, junctions) {
  let js = junctions.slice();
  for (;;) {
    const { degree } = mst(towns.concat(js));
    const keep = js.filter((_, i) => degree[towns.length + i] >= 3);
    if (keep.length === js.length) return js;
    js = keep;
  }
}

// Move each junction to the geometric median of its neighbours (Weiszfeld),
// which pulls lines towards meeting at 120 degrees.
export function polish(towns, junctions, rounds = 100) {
  let js = junctions.map((p) => p.slice());
  for (let r = 0; r < rounds; r++) {
    const pts = towns.concat(js);
    const nb = js.map(() => []);
    for (const [a, b] of mst(pts).edges) {
      if (a >= towns.length) nb[a - towns.length].push(pts[b]);
      if (b >= towns.length) nb[b - towns.length].push(pts[a]);
    }
    js = js.map((p, i) => (nb[i].length ? weiszfeld(p, nb[i]) : p));
  }
  return prune(towns, js);
}

function weiszfeld(p, qs) {
  let sx = 0, sy = 0, sw = 0;
  for (const q of qs) {
    const d = Math.max(1e-6, Math.hypot(p[0] - q[0], p[1] - q[1]));
    sx += q[0] / d;
    sy += q[1] / d;
    sw += 1 / d;
  }
  return [sx / sw, sy / sw];
}

function fermatPoint(a, b, c) {
  let p = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  for (let i = 0; i < 60; i++) p = weiszfeld(p, [a, b, c]);
  return p;
}

// A strong classic heuristic, used for the "best known" score (not the
// opponent): wherever two lines meet at a sharp angle, try a junction at the
// triangle's Fermat point, keep the best one, and repeat.
export function greedySteiner(towns) {
  let js = [];
  for (;;) {
    const pts = towns.concat(js);
    const cur = mst(pts);
    const adj = pts.map(() => []);
    for (const [a, b] of cur.edges) {
      adj[a].push(b);
      adj[b].push(a);
    }
    let best = null;
    for (let v = 0; v < pts.length; v++)
      for (let i = 0; i < adj[v].length; i++)
        for (let j = i + 1; j < adj[v].length; j++) {
          const cand = js.concat([fermatPoint(pts[v], pts[adj[v][i]], pts[adj[v][j]])]);
          const length = networkLength(towns, cand);
          if (length < cur.length - 0.5 && (!best || length < best.length)) best = { length, cand };
        }
    if (!best) return polish(towns, js);
    js = best.cand;
  }
}

export function savedPercent(base, length) {
  return ((base - length) / base) * 100;
}

// Genetic algorithm -----------------------------------------------------------

// The opponent. Seeded from the puzzle, so everyone fights the same algorithm
// on the same day. Each genome is a list of junction points; fitness is the
// length of the minimum spanning tree over towns + junctions (lower is better).
export const GA_SETTINGS = {
  population: 16,
  generations: 50,
  survivors: 0.25, // fraction of each generation that gets to breed
  addRate: 0.35,
  removeRate: 0.25,
  moveRate: 0.8,
  moveStart: 60, // how far a junction can jump early on, in board units
  moveEnd: 10, // ...and late on
};

export const DIFFICULTIES = {
  easy: { label: "Easy", settings: { ...GA_SETTINGS, population: 8, generations: 25, moveEnd: 20 } },
  normal: { label: "Normal", settings: GA_SETTINGS },
  hard: { label: "Hard", settings: { ...GA_SETTINGS, population: 40, generations: 160, moveEnd: 4 } },
};

export function createGA(puzzle, settings = GA_SETTINGS) {
  const s = { ...settings };
  const rand = rng(puzzle.seed ^ 0x9e3779b9);
  const { towns } = puzzle;
  const maxJunctions = towns.length - 2; // a Steiner tree never needs more

  const randomPoint = () => [rand() * BOARD, rand() * BOARD];
  const clamp = (v) => Math.min(BOARD, Math.max(0, v));
  const evaluate = (junctions) => ({ junctions, length: networkLength(towns, junctions) });

  let population = [];
  for (let i = 0; i < s.population; i++) {
    const js = [];
    const k = Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) js.push(randomPoint());
    population.push(evaluate(js));
  }
  population.sort((a, b) => a.length - b.length);

  let generation = 0;
  const history = [population[0].length];

  function mutate(junctions, progress) {
    const js = junctions.map((p) => p.slice());
    if (rand() < s.addRate && js.length < maxJunctions) js.push(randomPoint());
    if (rand() < s.removeRate && js.length > 0) js.splice(Math.floor(rand() * js.length), 1);
    if (rand() < s.moveRate && js.length > 0) {
      const sigma = s.moveStart + (s.moveEnd - s.moveStart) * progress;
      const p = js[Math.floor(rand() * js.length)];
      p[0] = clamp(p[0] + gaussian(rand) * sigma);
      p[1] = clamp(p[1] + gaussian(rand) * sigma);
    }
    return js;
  }

  function crossover(a, b) {
    const child = [];
    for (const p of a) if (rand() < 0.5) child.push(p.slice());
    for (const p of b) if (rand() < 0.5) child.push(p.slice());
    return child.slice(0, maxJunctions);
  }

  function step() {
    if (generation >= s.generations) return false;
    generation++;
    const progress = generation / s.generations;
    const keep = Math.max(2, Math.round(s.population * s.survivors));
    const parents = population.slice(0, keep);
    const next = [parents[0]]; // the champion always survives unchanged
    while (next.length < s.population) {
      const a = parents[Math.floor(rand() * keep)];
      const b = parents[Math.floor(rand() * keep)];
      next.push(evaluate(mutate(crossover(a.junctions, b.junctions), progress)));
    }
    next.sort((x, y) => x.length - y.length);
    population = next;
    history.push(population[0].length);
    return true;
  }

  return {
    step,
    get generation() { return generation; },
    get done() { return generation >= s.generations; },
    get best() { return population[0]; },
    history,
    settings: s,
  };
}

export function runGA(puzzle, settings) {
  const ga = createGA(puzzle, settings);
  while (ga.step());
  const junctions = prune(puzzle.towns, ga.best.junctions);
  return { junctions, length: networkLength(puzzle.towns, junctions), history: ga.history };
}
