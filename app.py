#!/usr/bin/env python3
"""
Library Book Checker — Flask web UI

Run:
    pip install -r requirements.txt
    python app.py
Then open http://localhost:5000
"""

import json
import os
import re
import time
from datetime import datetime

from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from check_books import (
    check_kindle_unlimited,
    load_to_read_books_from_string,
    search_libby,
)

app = Flask(__name__)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://",
)

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
MAX_CSV_BYTES = 5 * 1024 * 1024  # 5 MB

DEFAULT_LIBRARIES = [
    {"name": "SBCL Digital",      "url": "https://libbyapp.com/library/sbcldigital"},
    {"name": "LA County Library", "url": "https://libbyapp.com/library/lacountylibrary"},
]


# ── Config persistence ────────────────────────────────────────────────────────

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"libraries": DEFAULT_LIBRARIES}


def save_config(config: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)


def _extract_libby_key(url_or_key: str) -> str:
    """Return the library key from a full Libby URL or a bare key string."""
    m = re.search(r"libbyapp\.com/library/([^/?#\s]+)", url_or_key)
    return m.group(1) if m else url_or_key.strip().rstrip("/")


def _apply_book_filters(books: list, format_filter: str, limit: int) -> list:
    """Filter the to-read book list by format and optional count limit."""
    if format_filter != "all":
        targets = {
            "digital":  {"digital", "ebook"},
            "audio":    {"audio"},
            "physical": {"hardcover", "paperback"},
        }.get(format_filter, set())
        books = [b for b in books if b.get("format", "") in targets]

    if limit > 0:
        books = books[:limit]

    return books


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/config")
def get_config():
    # Config is stored client-side in localStorage.
    # Return empty so new users start fresh and don't see another user's libraries.
    return jsonify({"libraries": []})


@app.post("/config")
def post_config():
    data = request.get_json(force=True, silent=True) or {}
    libs = data.get("libraries")
    if not isinstance(libs, list):
        return jsonify({"error": "Expected {libraries: [...]}"}), 400
    # Validate: each entry must have name + url
    for lib in libs:
        if not isinstance(lib, dict) or not lib.get("name") or not lib.get("url"):
            return jsonify({"error": "Each library needs a name and url"}), 400
    save_config({"libraries": libs})
    return jsonify({"ok": True})


@app.post("/run")
@limiter.limit("10 per minute")
def run_check():
    csv_file = request.files.get("csv")
    if not csv_file:
        return jsonify({"error": "No CSV file provided"}), 400

    # Size check before any processing
    csv_bytes = csv_file.read(MAX_CSV_BYTES + 1)
    if len(csv_bytes) > MAX_CSV_BYTES:
        return jsonify({"error": "CSV file too large (max 5 MB)"}), 400

    skip_ku = request.form.get("skip_ku", "false").lower() == "true"

    try:
        delay = min(max(float(request.form.get("delay", 1.5)), 0.0), 10.0)
    except ValueError:
        delay = 1.5

    try:
        libraries_raw = json.loads(request.form.get("libraries", "[]"))
    except (json.JSONDecodeError, ValueError):
        return jsonify({"error": "Invalid libraries JSON"}), 400

    libraries = [
        {
            "name": lib["name"].strip(),
            "key":  _extract_libby_key(lib.get("url", lib.get("key", ""))),
        }
        for lib in libraries_raw
        if isinstance(lib, dict)
        and lib.get("name")
        and (lib.get("url") or lib.get("key"))
    ]

    if not libraries:
        return jsonify({"error": "No valid libraries provided"}), 400

    try:
        csv_text = csv_bytes.decode("utf-8-sig")
        books = load_to_read_books_from_string(csv_text)
    except Exception as exc:
        return jsonify({"error": f"CSV parse error: {exc}"}), 400

    format_filter = request.form.get("format_filter", "all")
    limit         = int(request.form.get("limit", "0") or "0")
    books = _apply_book_filters(books, format_filter, limit)

    try:
        start_index = int(request.form.get("start_index", "0") or "0")
    except ValueError:
        start_index = 0
    start_index = max(0, min(start_index, len(books)))

    @stream_with_context
    def generate():
        def evt(payload: dict) -> str:
            return f"data: {json.dumps(payload)}\n\n"

        # "total" always reflects the full filtered list so a resumed run's
        # progress bar picks up where a paused run left off instead of resetting.
        yield evt({"type": "total", "count": len(books)})

        for i, book in enumerate(books[start_index:], start_index + 1):
            title  = book["title"]
            author = book["author"]
            yield evt({"type": "progress", "i": i, "title": title, "author": author})

            libby_results: dict[str, dict] = {}
            for lib in libraries:
                libby_results[lib["name"]] = search_libby(lib["key"], title, author)
                time.sleep(delay)

            ku_result: dict = {"status": "skipped", "url": ""}
            if not skip_ku:
                ku_result = check_kindle_unlimited(title, author)
                time.sleep(delay)

            yield evt({
                "type":   "result",
                "i":      i,
                "title":  title,
                "author": author,
                "libby":  libby_results,
                "ku":     ku_result,
            })

        yield evt({"type": "done"})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5001, threaded=True)
