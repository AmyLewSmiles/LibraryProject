#!/usr/bin/env python3
"""
Storygraph To-Read → Libby + Kindle Unlimited Availability Checker

Usage:
    python check_books.py your_storygraph_export.csv
    python check_books.py your_storygraph_export.csv -o my_report.md
    python check_books.py your_storygraph_export.csv --no-ku   # skip Amazon
"""

import csv
import io
import re
import sys
import time
import argparse
from datetime import datetime
import requests
from bs4 import BeautifulSoup

# ── Configuration ─────────────────────────────────────────────────────────────

LIBRARIES = {
    "SBCL Digital": "sbcldigital",
    "LA County Library": "lacountylibrary",
}

REQUEST_DELAY = 1.5    # seconds between outbound requests — be polite
REQUEST_TIMEOUT = 20   # seconds before giving up on a request

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# Separate headers for the OverDrive JSON API
_OD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}

# ── Storygraph CSV ─────────────────────────────────────────────────────────────

def load_to_read_books_from_string(csv_content: str) -> list[dict]:
    """Return all to-read books from a CSV string (used by the web UI)."""
    csv_content = csv_content.lstrip("\ufeff")  # strip BOM if present
    books = []
    reader = csv.DictReader(io.StringIO(csv_content))
    for row in reader:
        if row.get("Read Status", "").strip().lower() == "to-read":
            authors_raw = row.get("Authors", row.get("Author", "")).strip()
            first_author = authors_raw.split(",")[0].strip()
            books.append({
                "title":      row.get("Title", "").strip(),
                "author":     first_author,
                "date_added": row.get("Date Added", "").strip(),
                "format":     row.get("Format", "").strip().lower(),
            })
    return books


def load_to_read_books(csv_path: str) -> list[dict]:
    """Return all books where 'Exclusive Shelf' == 'to-read'."""
    with open(csv_path, encoding="utf-8-sig") as fh:
        return load_to_read_books_from_string(fh.read())


# ── Libby / OverDrive ─────────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    """Lowercase, strip leading articles and punctuation for fuzzy matching."""
    text = text.lower().strip()
    text = re.sub(r"^(the|a|an)\s+", "", text)
    text = re.sub(r"[^\w\s]", "", text)
    return text


def search_libby(library_key: str, title: str, author: str) -> dict:
    """
    Search the OverDrive/Libby JSON API for a book's ebook and audiobook
    availability.  Uses the same internal API the Libby app uses.

    Returns a dict with two keys:
        {
            "ebook":     {"status": "available"|"waitlist"|"not_found"|"error",
                          "url": "..."},
            "audiobook": {"status": "available"|"waitlist"|"not_found"|"error",
                          "url": "..."},
        }
    """
    _not_found = {"status": "not_found", "url": ""}

    def _api_error(msg: str) -> dict:
        return {"status": "error", "message": msg, "url": ""}

    # 1. Search for the title in the library's OverDrive catalogue
    try:
        search_resp = requests.get(
            f"https://thunder.api.overdrive.com/v2/libraries/{library_key}/media",
            params={"query": f"{title} {author}", "perPage": 10,
                    "x-client-id": "dewey"},
            headers=_OD_HEADERS,
            timeout=REQUEST_TIMEOUT,
        )
        search_resp.raise_for_status()
    except requests.RequestException as exc:
        err = _api_error(str(exc))
        return {"ebook": err, "audiobook": err}

    items = search_resp.json().get("items", [])
    norm_title = _normalize(title)

    # 2. Find first matching ebook and first matching audiobook by fuzzy title
    matched: dict = {"ebook": None, "audiobook": None}
    for item in items:
        item_title = _normalize(item.get("title", ""))
        if norm_title not in item_title and item_title not in norm_title:
            continue
        media_type = item.get("type", {}).get("id", "")
        if media_type == "ebook" and matched["ebook"] is None:
            matched["ebook"] = item
        elif media_type == "audiobook" and matched["audiobook"] is None:
            matched["audiobook"] = item
        if matched["ebook"] and matched["audiobook"]:
            break

    # 3. Fetch availability for each matched item
    result: dict = {}
    for fmt_key, item in matched.items():
        if item is None:
            result[fmt_key] = dict(_not_found)
            continue
        media_id = item["id"]
        book_url = f"https://libbyapp.com/library/{library_key}/everything/page-1/{media_id}"
        try:
            avail_resp = requests.get(
                f"https://thunder.api.overdrive.com/v2/libraries/"
                f"{library_key}/media/{media_id}/availability",
                params={"x-client-id": "dewey"},
                headers=_OD_HEADERS,
                timeout=REQUEST_TIMEOUT,
            )
            avail_resp.raise_for_status()
            avail = avail_resp.json()
            result[fmt_key] = {
                "status": "available" if avail.get("isAvailable") else "waitlist",
                "url": book_url,
            }
        except requests.RequestException as exc:
            result[fmt_key] = _api_error(str(exc))
            result[fmt_key]["url"] = book_url

    return result


# ── Kindle Unlimited ──────────────────────────────────────────────────────────

# Amazon filter for Kindle Unlimited eligible titles
_KU_FILTER = "p_n_ways_to_read:21967258011"


def check_kindle_unlimited(title: str, author: str) -> dict:
    """
    Best-effort Kindle Unlimited check via Amazon product search.

    There is no official public API for this. Amazon may return CAPTCHAs or
    block requests. If that happens, status will be 'error' with a message.

    Returns dict with keys: status, url
      status: 'available' | 'not_found' | 'error'
    """
    query = f"{title} {author}"
    try:
        resp = requests.get(
            "https://www.amazon.com/s",
            params={"k": query, "i": "digital-text", "rh": _KU_FILTER},
            headers=HEADERS,
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        return {"status": "error", "message": str(exc), "url": ""}

    if resp.status_code in (403, 429, 503):
        return {
            "status": "error",
            "message": f"Amazon blocked request (HTTP {resp.status_code})",
            "url": "",
        }

    soup = BeautifulSoup(resp.text, "html.parser")

    # Detect CAPTCHA
    if soup.find("form", {"action": re.compile("validateCaptcha", re.I)}):
        return {"status": "error", "message": "Amazon returned a CAPTCHA", "url": ""}

    # Detect Akamai / bot-protection challenge (blank title + no page content)
    page_title = (soup.find("title") or soup.new_tag("title")).get_text().strip()
    has_akamai = "_abck" in resp.text or "akam-logo" in resp.text
    results = soup.select('[data-component-type="s-search-result"]')
    if not results and (has_akamai or not page_title):
        return {
            "status": "error",
            "message": "Amazon bot protection blocked this request",
            "url": "",
        }

    norm_title = _normalize(title)
    for result in results:
        # Title is inside [data-cy="title-recipe"] h2; ASIN is on the result element
        title_el = result.select_one('[data-cy="title-recipe"] h2') or result.select_one("h2")
        if not title_el:
            continue
        result_title = _normalize(title_el.get_text())
        if norm_title in result_title or result_title in norm_title:
            asin = result.get("data-asin", "")
            href = f"https://www.amazon.com/dp/{asin}" if asin else ""
            return {"status": "available", "url": href}

    return {"status": "not_found", "url": ""}


# ── Report builder ────────────────────────────────────────────────────────────

def _fmt_libby_sub(sub: dict) -> str:
    """Format a single ebook/audiobook availability sub-result."""
    s = sub.get("status", "not_found")
    if s == "available":
        return "✅ Available now"
    if s == "waitlist":
        return "⏳ Waitlist"
    if s == "not_found":
        return "❌ Not found"
    if s == "error":
        return f"⚠️  Error: {sub.get('message', 'unknown')}"
    return "❓ Unknown"


def _fmt_libby(r: dict) -> str:
    """Format a combined ebook+audiobook result for the console summary."""
    parts = []
    for fmt_key, label in (("ebook", "eBook"), ("audiobook", "Audiobook")):
        s = r.get(fmt_key, {}).get("status", "not_found")
        if s == "available":
            parts.append(f"✅ {label}")
        elif s == "waitlist":
            parts.append(f"⏳ {label} (waitlist)")
        elif s == "error":
            parts.append(f"⚠️ {label} error")
    return " / ".join(parts) if parts else "❌ Not found"


def _fmt_ku(r: dict) -> str:
    s = r["status"]
    if s == "available":
        return "✅ On Kindle Unlimited"
    if s == "not_found":
        return "❌ Not on KU"
    if s == "error":
        return f"⚠️  {r.get('message', 'unknown')}"
    if s == "skipped":
        return "— (skipped)"
    return "❓ Unknown"


def build_report(
    results: list[dict],
    library_names: list[str],
    ku_checked: bool,
) -> tuple[str, str]:
    """Return (console_text, markdown_text)."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    total = len(results)

    # Markdown document
    md = [
        "# Book Availability Report",
        "",
        f"**Generated:** {now}  ",
        f"**Libraries:** {', '.join(library_names)}  ",
        f"**Books checked:** {total}  ",
        f"**Kindle Unlimited check:** {'yes' if ku_checked else 'skipped'}",
        "",
        "---",
        "",
    ]

    # Console header
    con = [
        "",
        "=" * 66,
        f"  BOOK AVAILABILITY REPORT  —  {now}",
        "=" * 66,
        "",
    ]

    # Tracking buckets for summary
    libby_avail: list[str] = []
    libby_wait: list[str] = []
    ku_avail: list[str] = []

    for r in results:
        title  = r["title"]
        author = r["author"]
        libby  = r["libby"]   # dict[lib_name → result]
        ku     = r["ku"]

        label = f"**{title}** by {author}"

        # ── Console entry ──
        con.append(f"  {title}")
        con.append(f"  by {author}")
        for lib_name, lib_res in libby.items():
            con.append(f"    {lib_name:<30} {_fmt_libby(lib_res)}")
        if ku_checked:
            con.append(f"    {'Kindle Unlimited':<30} {_fmt_ku(ku)}")
        con.append("")

        # ── Markdown entry ──
        md.append(f"## {title}")
        md.append(f"*by {author}*")
        md.append("")
        md.append("| Source | Format | Status | Link |")
        md.append("|--------|--------|--------|------|")
        for lib_name, lib_res in libby.items():
            for fmt_key, fmt_label in (("ebook", "eBook"), ("audiobook", "Audiobook")):
                sub  = lib_res.get(fmt_key, {})
                link = f"[Open]({sub['url']})" if sub.get("url") else "—"
                md.append(f"| {lib_name} | {fmt_label} | {_fmt_libby_sub(sub)} | {link} |")
        if ku_checked:
            ku_link = f"[Open]({ku['url']})" if ku.get("url") else "—"
            md.append(f"| Kindle Unlimited | — | {_fmt_ku(ku)} | {ku_link} |")
        md.append("")

        # ── Buckets ──
        def _any_status(lib_res, status):
            return (lib_res.get("ebook",     {}).get("status") == status or
                    lib_res.get("audiobook", {}).get("status") == status)

        if any(_any_status(v, "available") for v in libby.values()):
            libby_avail.append(label)
        elif any(_any_status(v, "waitlist") for v in libby.values()):
            libby_wait.append(label)
        if ku["status"] == "available":
            ku_avail.append(label)

    # ── Summary ──
    md += [
        "---",
        "",
        "## Summary",
        "",
        f"### ✅ Available on Libby now ({len(libby_avail)})",
        *([f"- {b}" for b in libby_avail] if libby_avail else ["- *None*"]),
        "",
        f"### ⏳ On Libby waitlist ({len(libby_wait)})",
        *([f"- {b}" for b in libby_wait] if libby_wait else ["- *None*"]),
        "",
    ]
    if ku_checked:
        md += [
            f"### 📖 On Kindle Unlimited ({len(ku_avail)})",
            *([f"- {b}" for b in ku_avail] if ku_avail else ["- *None*"]),
            "",
        ]

    con += [
        "─" * 66,
        "  SUMMARY",
        "─" * 66,
        f"  Available on Libby NOW  : {len(libby_avail)} book(s)",
        f"  On Libby waitlist       : {len(libby_wait)} book(s)",
    ]
    if ku_checked:
        con.append(f"  On Kindle Unlimited     : {len(ku_avail)} book(s)")
    con += [
        "=" * 66,
        "",
    ]

    return "\n".join(con), "\n".join(md)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Check your Storygraph to-read list against Libby "
            "(SBCL Digital + LA County Library) and Kindle Unlimited."
        )
    )
    parser.add_argument(
        "csv",
        help="Path to your Storygraph CSV export",
    )
    parser.add_argument(
        "-o", "--output",
        default="book_availability_report.md",
        help="Output markdown file (default: book_availability_report.md)",
    )
    parser.add_argument(
        "--no-ku",
        action="store_true",
        help="Skip Kindle Unlimited check (avoids Amazon requests)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=REQUEST_DELAY,
        metavar="SECS",
        help=f"Seconds between requests (default: {REQUEST_DELAY})",
    )
    args = parser.parse_args()

    print(f"Loading: {args.csv}")
    try:
        books = load_to_read_books(args.csv)
    except FileNotFoundError:
        sys.exit(f"ERROR: File not found: {args.csv}")

    print(f"Found {len(books)} to-read book(s).\n")
    if not books:
        sys.exit("No books with shelf 'to-read' found — check your CSV column names.")

    lib_names = list(LIBRARIES.keys())
    results: list[dict] = []

    for i, book in enumerate(books, 1):
        title, author = book["title"], book["author"]
        print(f"[{i}/{len(books)}] {title}  —  {author}")

        libby_results: dict[str, dict] = {}
        for lib_name, lib_key in LIBRARIES.items():
            libby_results[lib_name] = search_libby(lib_key, title, author)
            time.sleep(args.delay)

        if args.no_ku:
            ku_result: dict = {"status": "skipped", "url": ""}
        else:
            ku_result = check_kindle_unlimited(title, author)
            time.sleep(args.delay)

        results.append({
            "title": title,
            "author": author,
            "libby": libby_results,
            "ku": ku_result,
        })

    console_out, md_out = build_report(results, lib_names, ku_checked=not args.no_ku)
    print(console_out)

    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(md_out)
    print(f"Report saved → {args.output}\n")


if __name__ == "__main__":
    main()
