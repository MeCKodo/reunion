#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

DB_FILE = Path(__file__).resolve().parent / "data" / "chat_index.db"
STATIC_FILE = Path(__file__).resolve().parent / "static" / "index.html"
DEFAULT_SOURCE_ROOT = Path.home() / ".cursor" / "projects"


def ensure_db_dir() -> None:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            repo TEXT NOT NULL,
            file_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            content TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
        USING fts5(content, repo, session_key UNINDEXED)
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)")
    conn.commit()


def tokenize_fts_query(text: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_\-\u4e00-\u9fff]+", text)
    if not tokens:
        return ""
    return " AND ".join(f'"{token}"' for token in tokens)


def find_transcript_files(source_root: Path):
    pattern = source_root.glob("*/agent-transcripts/*.txt")
    for path in pattern:
        if path.is_file():
            yield path


def build_index(source_root: Path) -> dict:
    source_root = source_root.expanduser().resolve()
    if not source_root.exists():
        raise FileNotFoundError(f"source root not found: {source_root}")

    ensure_db_dir()
    conn = get_conn()
    init_schema(conn)

    start = time.time()
    files = list(find_transcript_files(source_root))

    conn.execute("DELETE FROM sessions")
    conn.execute("DELETE FROM sessions_fts")

    inserted = 0
    for file_path in files:
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            stat = file_path.stat()
            repo = file_path.parent.parent.name
            session_id = file_path.stem
            session_key = f"{repo}:{session_id}"
            conn.execute(
                """
                INSERT INTO sessions(session_key, session_id, repo, file_path, updated_at, size_bytes, content)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_key,
                    session_id,
                    repo,
                    str(file_path),
                    int(stat.st_mtime),
                    int(stat.st_size),
                    content,
                ),
            )
            conn.execute(
                "INSERT INTO sessions_fts(content, repo, session_key) VALUES(?, ?, ?)",
                (content, repo, session_key),
            )
            inserted += 1
        except Exception:
            continue

    conn.commit()
    conn.close()

    return {
        "source_root": str(source_root),
        "files_found": len(files),
        "sessions_indexed": inserted,
        "elapsed_ms": int((time.time() - start) * 1000),
    }


def query_repos(conn: sqlite3.Connection):
    rows = conn.execute(
        """
        SELECT repo, COUNT(*) AS session_count, MAX(updated_at) AS last_updated_at
        FROM sessions
        GROUP BY repo
        ORDER BY session_count DESC, repo ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def search_sessions(conn: sqlite3.Connection, q: str, repo: str, limit: int):
    repo = repo.strip()
    q = q.strip()
    limit = max(1, min(limit, 500))

    if not q:
        sql = """
        SELECT session_key, session_id, repo, file_path, updated_at, size_bytes,
               substr(content, 1, 240) AS snippet
        FROM sessions
        WHERE (? = '' OR repo = ?)
        ORDER BY updated_at DESC
        LIMIT ?
        """
        rows = conn.execute(sql, (repo, repo, limit)).fetchall()
        return [dict(row) for row in rows]

    fts_q = tokenize_fts_query(q)
    if fts_q:
        try:
            sql = """
            SELECT s.session_key, s.session_id, s.repo, s.file_path, s.updated_at, s.size_bytes,
                   snippet(sessions_fts, 0, '<mark>', '</mark>', ' ... ', 18) AS snippet
            FROM sessions_fts
            JOIN sessions s ON s.session_key = sessions_fts.session_key
            WHERE sessions_fts MATCH ?
              AND (? = '' OR s.repo = ?)
            ORDER BY s.updated_at DESC
            LIMIT ?
            """
            rows = conn.execute(sql, (fts_q, repo, repo, limit)).fetchall()
            return [dict(row) for row in rows]
        except sqlite3.OperationalError:
            pass

    like_q = f"%{q}%"
    sql = """
    SELECT session_key, session_id, repo, file_path, updated_at, size_bytes,
           substr(content, 1, 240) AS snippet
    FROM sessions
    WHERE content LIKE ?
      AND (? = '' OR repo = ?)
    ORDER BY updated_at DESC
    LIMIT ?
    """
    rows = conn.execute(sql, (like_q, repo, repo, limit)).fetchall()
    return [dict(row) for row in rows]


def get_session(conn: sqlite3.Connection, session_key: str):
    row = conn.execute(
        """
        SELECT session_key, session_id, repo, file_path, updated_at, size_bytes, content
        FROM sessions
        WHERE session_key = ?
        """,
        (session_key,),
    ).fetchone()
    return dict(row) if row else None


class AppHandler(BaseHTTPRequestHandler):
    source_root = DEFAULT_SOURCE_ROOT

    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, status: int, html: str):
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/":
            if not STATIC_FILE.exists():
                self._send_html(404, "index.html not found")
                return
            self._send_html(200, STATIC_FILE.read_text(encoding="utf-8"))
            return

        if path == "/api/repos":
            conn = get_conn()
            try:
                payload = {"repos": query_repos(conn)}
            finally:
                conn.close()
            self._send_json(200, payload)
            return

        if path == "/api/search":
            q = qs.get("q", [""])[0]
            repo = qs.get("repo", [""])[0]
            limit_raw = qs.get("limit", ["100"])[0]
            try:
                limit = int(limit_raw)
            except ValueError:
                limit = 100

            conn = get_conn()
            try:
                results = search_sessions(conn, q=q, repo=repo, limit=limit)
            finally:
                conn.close()

            self._send_json(200, {"count": len(results), "results": results})
            return

        if path.startswith("/api/session/"):
            session_key = unquote(path[len("/api/session/") :])
            conn = get_conn()
            try:
                row = get_session(conn, session_key)
            finally:
                conn.close()

            if not row:
                self._send_json(404, {"error": "session not found"})
                return
            self._send_json(200, row)
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/reindex":
            self._send_json(404, {"error": "not found"})
            return

        try:
            stats = build_index(self.source_root)
            self._send_json(200, {"ok": True, "stats": stats})
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": str(exc)})


def run_server(host: str, port: int, source_root: Path):
    ensure_db_dir()
    if not DB_FILE.exists():
        build_index(source_root)

    AppHandler.source_root = source_root
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"reunion running: http://{host}:{port}")
    print(f"source_root: {source_root}")
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Cursor transcript explorer MVP")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_index = sub.add_parser("index", help="Build transcript index")
    p_index.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT))

    p_serve = sub.add_parser("serve", help="Run web server")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=9765)
    p_serve.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT))

    args = parser.parse_args()
    source_root = Path(args.source_root).expanduser().resolve()

    if args.cmd == "index":
        stats = build_index(source_root)
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return

    if args.cmd == "serve":
        run_server(args.host, args.port, source_root)
        return


if __name__ == "__main__":
    main()
