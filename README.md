# Steiner Point

A puzzle game at [steiner.kanealex.com](https://steiner.kanealex.com): connect the towns with as little cable as you can by adding junctions (Steiner points). Three modes: a ranked daily puzzle, story levels, and head to head against a genetic algorithm.

A rebuild of the 2021 Power Grid Optimization game from the old resume site. Under the hood it's the Euclidean Steiner tree problem: score is the length of the minimum spanning tree over towns plus your junctions.

- `index.html`: how to play, with worked examples drawn by the real scoring code. Returning players are sent straight to the game.
- `play.html`, `style.css`: the game. No build step, no dependencies.
- `js/core.js`: seeded puzzle generation, Prim's MST, the genetic algorithm, and a greedy Steiner heuristic for the "best known" score. No DOM, so it also runs in Node.
- `js/story.js`: story mode levels (8 hand-made, the rest seeded), goals, junction limits and stars.
- `js/app.js`: the three modes (Daily, Story, vs Algorithm), board, touch/mouse input, the fight animation, stats and sharing.
- `tools/tune.js`: `node tools/tune.js 30` prints how the algorithm scores against the best known over the next 30 puzzles. Use it after changing `GA_SETTINGS`.

The daily puzzle and the algorithm are both seeded from the player's local date, so everyone gets the same towns and the same opponent. Changing `makePuzzle`, `GA_SETTINGS` or the RNG changes every past and future puzzle.

## Deploy

Static files served by Caddy from `/var/www/steiner-point` on the Vultr server. Pushes to `main` deploy via `.github/workflows/deploy.yml` (SSH in and `git pull --ff-only`).
