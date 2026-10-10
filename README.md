# Gridlines

A puzzle game at [gridlines.kanealex.com](https://gridlines.kanealex.com): connect the towns with as little cable as you can by adding junctions (Steiner points). Three modes: a ranked daily puzzle, story levels, and head to head against a genetic algorithm.

A rebuild of the 2021 Power Grid Optimization game from the old resume site. Under the hood it's the Euclidean Steiner tree problem: score is the length of the minimum spanning tree over towns plus your junctions.

- `index.html`: how to play, with worked examples drawn by the real scoring code. Returning players are sent straight to the game.
- `play.html`, `style.css`: the game. No build step, no dependencies.
- `js/core.js`: seeded puzzle generation, Prim's MST, the genetic algorithm, and a greedy Steiner heuristic for the "best known" score. No DOM, so it also runs in Node.
- `js/story.js`: story mode levels (8 hand-made, the rest seeded), goals, junction limits and stars.
- `js/app.js`: the three modes (Daily, Practice against the algorithm, Story), board, touch/mouse input, the fight animation, stats and sharing.
- `server/server.py`: serves the site plus the scores API behind the Daily rank line and the 7-day leaderboard. Python standard library only; scores go in `data/gridlines.db` (SQLite).
- `tools/tune.js`: `node tools/tune.js 30` prints how the algorithm scores against the best known over the next 30 puzzles. Use it after changing `GA_SETTINGS`.

The daily puzzle and the algorithm are both seeded from the player's local date, so everyone gets the same towns and the same opponent. Changing `makePuzzle`, `GA_SETTINGS` or the RNG changes every past and future puzzle.

## Run locally

    python server/server.py

then open http://localhost:8123. Plain static hosting (or opening the files) also works: the game just skips the rank line and the leaderboard.

## Scores API

Modelled on Semantic Drift's leaderboard. Each browser gets an anonymous 32-hex token in localStorage, and an optional nickname.

- `POST /api/daily-result` `{date, length, base, best, junctions, token}`: records the first Daily result per player per day and returns `{totalPlayers, position, points}`. Position is by network length (ties share a place); points are 100 x your share of the best known saving.
- `GET /api/daily-rank?date=&length=`: today's position without submitting.
- `GET /api/leaderboard?token=`: top 10 by points over the last 7 days, plus your own row.
- `POST /api/nickname` `{token, nickname}`: 1 to 20 letters, digits, spaces, `-` or `_`.

Scores are reported by the browser, the same trade-off Semantic Drift makes.

## Deploy

Runs the same way as Semantic Drift: `.github/workflows/deploy.yml` rsyncs the repo to `~/gridlines` on the Vultr server and runs `docker compose up -d --build`. The container listens on `127.0.0.1:8123`; scores persist in `~/gridlines/data/gridlines.db` on the host.

One-time setup:

1. Repository secrets `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY`, the same values Semantic Drift uses.
2. DNS: an `A` record for `gridlines` pointing at the server.
3. Caddy, in `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`:

        gridlines.kanealex.com {
            encode gzip
            reverse_proxy 127.0.0.1:8123
        }
