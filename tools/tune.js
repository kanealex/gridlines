// Prints how the daily algorithm does against the best-known score over the
// next N puzzles, to check it is beatable but not a pushover.
// Usage: node tools/tune.js [days]
import { makePuzzle, runGA, savedPercent } from "../js/core.js";

const days = +(process.argv[2] || 30);
let ga = 0, best = 0;
for (let d = 0; d < days; d++) {
  const key = new Date(Date.UTC(2026, 9, 10 + d)).toISOString().slice(0, 10);
  const t = Date.now();
  const pz = makePuzzle(key);
  const g = savedPercent(pz.base, runGA(pz).length);
  const b = savedPercent(pz.base, Math.min(pz.bestKnown, pz.base));
  ga += g; best += b;
  console.log(key, String(pz.towns.length).padStart(2), "towns  algorithm", g.toFixed(2).padStart(5), "%  best known", b.toFixed(2).padStart(5), "%  ", Date.now() - t, "ms");
}
console.log("average: algorithm", (ga / days).toFixed(2), "% best known", (best / days).toFixed(2), "% ratio", (ga / best).toFixed(2));
