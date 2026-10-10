"""Gridlines server: serves the static game and a small scores API.

Standard library only (no pip install), so the same file runs on the Vultr
server and on a laptop:

    python server/server.py              # http://localhost:8123
    PORT=5001 python server/server.py

API (modelled on Semantic Drift's daily leaderboard):

    POST /api/daily-result   {date, length, base, best, junctions, token}
                             -> {totalPlayers, position, points}
    GET  /api/daily-rank     ?date=&length=  -> {totalPlayers, position}
    GET  /api/leaderboard    ?token=         -> {entries: [...], you}
    POST /api/nickname       {token, nickname}
    GET  /api/health

Everyone plays the same daily puzzle, so the day's ranking is simply by
network length (shorter is better). The 7-day leaderboard sums daily
points: 100 x the share of the best known saving you found, capped at 100.

Scores are client-reported, the same trade-off Semantic Drift makes: a
forged request could post a great score, but there's nothing riding on an
anonymous puzzle leaderboard worth hardening against. Basic sanity checks
stop junk rows (see parse_result).
"""

import json
import mimetypes
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("GRIDLINES_DB", os.path.join(ROOT, "data", "gridlines.db"))
PORT = int(os.environ.get("PORT", "8123"))
HOST = os.environ.get("HOST", "0.0.0.0")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
# Letters, digits, spaces, - and _ only: names are shown to every player, so
# nothing that could carry markup gets stored at all.
NICKNAME_RE = re.compile(r"^[A-Za-z0-9 _-]{1,20}$")
MAX_BODY = 4096
# Files the static handler may serve. Everything else (server/, data/, .git)
# is refused.
STATIC_EXT = {".html", ".css", ".js", ".svg", ".png", ".jpg", ".ico", ".webmanifest", ".txt"}
BLOCKED_DIRS = {"server", "data", "tools", ".git", ".github"}

mimetypes.add_type("text/javascript", ".js")


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS daily_results (
                date        TEXT NOT NULL,
                token       TEXT NOT NULL,
                length      REAL NOT NULL,
                base        REAL NOT NULL,
                points      INTEGER NOT NULL,
                junctions   INTEGER NOT NULL,
                created_at  TEXT NOT NULL,
                PRIMARY KEY (date, token)
            );
            CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_results(date);
            CREATE INDEX IF NOT EXISTS idx_daily_created ON daily_results(created_at);
            CREATE TABLE IF NOT EXISTS player_names (
                token       TEXT PRIMARY KEY,
                nickname    TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            """
        )
        conn.commit()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def number(value, name, low, high):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number")
    if not (low <= v <= high):
        raise ValueError(f"{name} is out of range")
    return v


def rank_position(conn, date, length):
    """(players today, your position). Standard competition ranking: ties
    share a position. Lengths are compared at 0.1 km, the precision the game
    shows, so two networks that look equal rank equal."""
    length = round(length, 1)
    total = conn.execute("SELECT COUNT(*) FROM daily_results WHERE date=?", (date,)).fetchone()[0]
    ahead = conn.execute(
        "SELECT COUNT(*) FROM daily_results WHERE date=? AND ROUND(length, 1) < ?", (date, length)
    ).fetchone()[0]
    return total, ahead + 1


def parse_result(body):
    date = body.get("date")
    if not isinstance(date, str) or not DATE_RE.match(date):
        raise ValueError("date must be YYYY-MM-DD")
    token = body.get("token")
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise ValueError("token must be 32 hex characters")
    base = number(body.get("base"), "base", 100, 20000)
    best = number(body.get("best"), "best", base * 0.8, base)
    length = number(body.get("length"), "length", best * 0.99, base * 3)
    junctions = int(number(body.get("junctions"), "junctions", 0, 50))
    share = (base - length) / (base - best) if base > best else 1.0
    points = max(0, min(100, round(share * 100)))
    return date, token, length, base, points, junctions


class Handler(SimpleHTTPRequestHandler):
    server_version = "Gridlines/1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # Quieter logs: one line per API call, none for static files.
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if not self.path.startswith("/api/"):
            # Short cache so a deploy shows up quickly.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # --- helpers ---

    def send_json(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("expected a small JSON body")
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise ValueError("invalid JSON")
        if not isinstance(body, dict):
            raise ValueError("expected a JSON object")
        return body

    # --- routing ---

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == "/api/health":
                    return self.send_json({"ok": True})
                if url.path == "/api/daily-rank":
                    return self.daily_rank(q)
                if url.path == "/api/leaderboard":
                    return self.leaderboard(q)
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_json({"error": "not found"}, 404)
        return self.static(url.path)

    def do_HEAD(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.send_json({"error": "not found"}, 404)
        return self.static(url.path, head=True)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            body = self.read_json()
            if url.path == "/api/daily-result":
                return self.daily_result(body)
            if url.path == "/api/nickname":
                return self.nickname(body)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        return self.send_json({"error": "not found"}, 404)

    def static(self, path, head=False):
        if path.endswith("/"):
            path += "index.html"
        parts = [p for p in path.split("/") if p]
        ext = os.path.splitext(path)[1].lower()
        if (not parts or parts[0] in BLOCKED_DIRS or any(p.startswith(".") for p in parts)
                or ext not in STATIC_EXT):
            self.send_error(404)
            return
        self.path = "/" + "/".join(parts)
        return super().do_HEAD() if head else super().do_GET()

    # --- API ---

    def daily_result(self, body):
        date, token, length, base, points, junctions = parse_result(body)
        with closing(sqlite3.connect(DB_PATH)) as conn:
            # Everyone gets the same puzzle, so every row for a day should
            # share its plain-network length. Reject anything that doesn't.
            row = conn.execute("SELECT base FROM daily_results WHERE date=? LIMIT 1", (date,)).fetchone()
            if row and abs(row[0] - base) > 0.5:
                raise ValueError("that isn't this day's puzzle")
            # One result per player per day: the first submission counts.
            conn.execute(
                "INSERT OR IGNORE INTO daily_results (date, token, length, base, points, junctions, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (date, token, length, base, points, junctions, now_iso()),
            )
            conn.commit()
            stored = conn.execute(
                "SELECT length, points FROM daily_results WHERE date=? AND token=?", (date, token)
            ).fetchone()
            total, position = rank_position(conn, date, stored[0])
        return self.send_json({"totalPlayers": total, "position": position, "points": stored[1]})

    def daily_rank(self, q):
        date = q.get("date", "")
        if not DATE_RE.match(date):
            raise ValueError("date must be YYYY-MM-DD")
        length = number(q.get("length"), "length", 1, 100000)
        with closing(sqlite3.connect(DB_PATH)) as conn:
            total, position = rank_position(conn, date, length)
        return self.send_json({"totalPlayers": total, "position": position})

    def leaderboard(self, q):
        token = q.get("token")
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            token = None
        cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        ranked = (
            "WITH ranked AS ("
            "  SELECT d.token AS token, SUM(d.points) AS total, COUNT(*) AS days, p.nickname AS nickname,"
            "         RANK() OVER (ORDER BY SUM(d.points) DESC) AS rnk"
            "  FROM daily_results d LEFT JOIN player_names p ON p.token = d.token"
            "  WHERE d.created_at >= ?"
            "  GROUP BY d.token"
            ") "
        )
        with closing(sqlite3.connect(DB_PATH)) as conn:
            top = conn.execute(ranked + "SELECT rnk, token, total, days, nickname FROM ranked ORDER BY rnk LIMIT 10",
                               (cutoff,)).fetchall()
            you = None
            if token:
                you = conn.execute(ranked + "SELECT rnk, token, total, days, nickname FROM ranked WHERE token=?",
                                   (cutoff, token)).fetchone()

        def entry(r):
            return {"rank": r[0], "token": r[1], "totalPoints": r[2], "daysPlayed": r[3], "nickname": r[4]}

        return self.send_json({"entries": [entry(r) for r in top], "you": entry(you) if you else None})

    def nickname(self, body):
        token, name = body.get("token"), body.get("nickname")
        if not isinstance(token, str) or not TOKEN_RE.match(token):
            raise ValueError("expected {token, nickname}")
        if not isinstance(name, str) or not NICKNAME_RE.match(name.strip()):
            raise ValueError("names can use 1-20 letters, numbers, spaces, - or _")
        with closing(sqlite3.connect(DB_PATH)) as conn:
            conn.execute(
                "INSERT INTO player_names (token, nickname, updated_at) VALUES (?,?,?)"
                " ON CONFLICT(token) DO UPDATE SET nickname=excluded.nickname, updated_at=excluded.updated_at",
                (token, name.strip(), now_iso()),
            )
            conn.commit()
        return self.send_json({"ok": True, "nickname": name.strip()})


def main():
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Gridlines running at http://localhost:{PORT}  (scores in {DB_PATH})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
