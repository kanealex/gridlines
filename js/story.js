// Story mode levels. The first few are hand-made to teach one idea each;
// the rest are seeded puzzles that grow in size and ask for more.
//
// Each level's goal is a share of the best known saving, and its junction
// limit is the number of junctions the best known network uses, so every
// level can be solved with the fewest points possible.

import { makePuzzle, puzzleFromTowns, bestNetwork, savedPercent } from "./core.js";

const regular = (n, r, cx, cy, turn = -Math.PI / 2) =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(turn + (2 * Math.PI * i) / n), cy + r * Math.sin(turn + (2 * Math.PI * i) / n)]);

const HANDMADE = [
  { name: "Three towns", towns: [[200, 700], [800, 700], [500, 180.4]], goal: 0.6,
    tip: "Put one junction in the middle of the three towns." },
  { name: "Lopsided", towns: [[150, 760], [860, 640], [380, 190]], goal: 0.7,
    tip: "The best spot isn't the centre. Aim for three lines meeting at equal angles." },
  { name: "Four corners", towns: [[250, 250], [750, 250], [250, 750], [750, 750]], goal: 0.6,
    tip: "Two junctions, joined to each other, each linking two corners." },
  { name: "City block", towns: [[130, 320], [870, 320], [130, 680], [870, 680]], goal: 0.7,
    tip: "Like Four corners, but stretched. The link between the junctions runs the long way." },
  { name: "Too wide", towns: [[90, 470], [500, 330], [910, 470], [500, 860]], goal: 0.7,
    tip: "Where lines already meet at a wide angle, a junction can't help. Find where it can." },
  { name: "Pentagon", towns: regular(5, 360, 500, 530), goal: 0.6,
    tip: "Three junctions. Think of a tree with branches that split in two." },
  { name: "Crossroads", towns: [[500, 500], [500, 160], [840, 500], [500, 840], [160, 500]], goal: 0.6,
    tip: "Even the centre town doesn't have to be where the lines meet." },
  { name: "Two villages", towns: [[130, 220], [370, 150], [290, 400], [640, 640], [880, 600], [760, 870]], goal: 0.7,
    tip: "Solve each village, then check the link between them." },
];

const GENERATED = 16;
export const LEVEL_COUNT = HANDMADE.length + GENERATED;

const cache = new Map();

export function getLevel(index) {
  if (cache.has(index)) return cache.get(index);
  let level;
  if (index < HANDMADE.length) {
    const h = HANDMADE[index];
    level = { ...h, puzzle: puzzleFromTowns(`story-${index + 1}`, h.towns) };
  } else {
    const g = index - HANDMADE.length; // 0 .. GENERATED-1
    const count = Math.min(12, 6 + Math.floor(g / 2));
    level = {
      name: `Region ${g + 1}`,
      goal: Math.min(0.9, 0.65 + g * 0.02),
      tip: "",
      puzzle: makePuzzle(`story-${index + 1}`, { count, minPotential: 3 }),
    };
  }
  const best = bestNetwork(level.puzzle);
  const { base } = level.puzzle;
  const bestSaving = base - best.length;
  level.index = index;
  level.best = best;
  level.maxJunctions = Math.max(1, best.junctions.length);
  // Lengths needed for 1, 2 and 3 stars.
  const at = (share) => base - bestSaving * share;
  level.targets = [at(level.goal), at(level.goal + (1 - level.goal) / 2), at(0.98)];
  level.goalPercent = savedPercent(base, level.targets[0]);
  cache.set(index, level);
  return level;
}

export function starsFor(level, length) {
  return level.targets.filter((t) => length <= t + 1e-9).length;
}
