#!/usr/bin/env python3
"""
Richcraft Homes community scraper for Ottawa New Build Map.
Scrapes all active Richcraft communities and updates builds.json.

Usage:
    python3 scrapers/richcraft.py

Run from /Users/xingsbot/NewBuildMap/
"""

import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Optional, Tuple, List

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────

BUILDS_JSON = Path(__file__).parent.parent / "public" / "data" / "builds.json"

COMMUNITIES = [
    {
        "id": "richcraft-pathways",
        "url": "https://www.richcraft.com/community/ottawa-south/pathways/",
        "community": "Findlay Creek",
        "address": "126 Dun Skipper Drive, Findlay Creek, Ottawa, ON",
        "lat": 45.309590,
        "lng": -75.590555,
    },
    {
        "id": "richcraft-riverside-south",
        "url": "https://www.richcraft.com/community/ottawa-south/riverside-south/",
        "community": "Riverside South",
        "address": "821 Atrium Ridge, Riverside South, Ottawa, ON",
        "lat": 45.260657,
        "lng": -75.698711,
    },
    {
        "id": "richcraft-bradley-commons",
        "url": "https://www.richcraft.com/community/ottawa-west/bradley_commons/",
        "community": "Stittsville",
        "address": "558 Bobolink Ridge, Stittsville, Ottawa, ON",
        "lat": 45.268927,
        "lng": -75.895341,
    },
    {
        "id": "richcraft-mapleton",
        "url": "https://www.richcraft.com/community/ottawa-west/mapleton/",
        "community": "Kanata",
        "address": "201 Hampshire Place, Kanata, Ottawa, ON",
        "lat": 45.292857,
        "lng": -75.909849,
    },
    {
        "id": "richcraft-westwood",
        "url": "https://www.richcraft.com/community/ottawa-west/westwood/",
        "community": "Stittsville",
        "address": "Westwood Drive, Stittsville, Ottawa, ON",
        "lat": 45.263117,
        "lng": -75.891442,
    },
    {
        "id": "richcraft-kanata-lakes",
        "url": "https://www.richcraft.com/community/ottawa-west/kanata-lakes/",
        "community": "Kanata North",
        "address": "1215 Tamworth Lane, Kanata, Ottawa, ON",
        "lat": 45.334798,
        "lng": -75.922468,
    },
    {
        "id": "richcraft-gateway-flats",
        "url": "https://www.richcraft.com/community/ottawa-west/gateway-flats/",
        "community": "Kanata",
        "address": "201 Hampshire Place, Kanata, Ottawa, ON",
        "lat": 45.293200,
        "lng": -75.909200,
    },
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

# ─────────────────────────────────────────────
# HTTP helper
# ─────────────────────────────────────────────

def fetch(url: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (html_text, error_message).
    error_message is None on success.
    """
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status == 200:
                return r.read().decode("utf-8", errors="replace"), None
            return None, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code} — page may be down or URL changed"
    except urllib.error.URLError as e:
        return None, f"Network error: {e.reason}"
    except Exception as e:
        return None, f"Unexpected error: {e}"


# ─────────────────────────────────────────────
# Parse helpers
# ─────────────────────────────────────────────

def strip_tags(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_price(raw: str) -> Optional[int]:
    """Extract integer price from a string like 'From $574,660'."""
    m = re.search(r"[\$]?([\d,]+)", raw.replace("\xa0", ""))
    if m:
        return int(m.group(1).replace(",", ""))
    return None


# ─────────────────────────────────────────────
# Product-line parser
# Richcraft pages list products like:
#   "Thrive Towns From $574,660"
#   "Single Family Homes From $980,900"
# ─────────────────────────────────────────────

PRODUCT_PATTERN = re.compile(
    r"(Thrive Towns|Urban Towns|Bungalow Towns|Townhomes?|Single Family Homes?|Flats?|Bungalows?)"
    r"\s+(?:Now\s+)?From\s+\$([\d,]+)",
    re.IGNORECASE,
)

TYPE_MAP = {
    "thrive towns":      ("Thrive Towns",   "townhouse"),
    "urban towns":       ("Urban Towns",    "townhouse"),
    "bungalow towns":    ("Bungalow Towns", "townhouse"),
    "townhomes":         ("Townhomes",      "townhouse"),
    "townhome":          ("Townhomes",      "townhouse"),
    "single family homes": ("Single Family Homes", "single-family"),
    "single family home":  ("Single Family Homes", "single-family"),
    "flats":             ("Flats",          "condo"),
    "flat":              ("Flats",          "condo"),
    "bungalows":         ("Bungalows",      "single-family"),
    "bungalow":          ("Bungalows",      "single-family"),
}

def parse_products(text: str, source_url: str, scraped_at: str) -> List[dict]:
    models = []
    seen = set()
    for m in PRODUCT_PATTERN.finditer(text):
        raw_name = m.group(1).strip().lower()
        price    = int(m.group(2).replace(",", ""))
        label, _ = TYPE_MAP.get(raw_name, (m.group(1).strip(), "mixed"))
        if label not in seen:
            seen.add(label)
            models.append({
                "name":           label,
                "type":           TYPE_MAP.get(raw_name, ("", "mixed"))[1].replace("single-family", "Single Family").replace("townhouse", "Townhouse").replace("condo", "Condo"),
                "priceFrom":      price,
                "beds":           None,
                "baths":          None,
                "sqft":           None,
                "lotWidth":       None,
                # ── provenance ──
                "priceSource":    "community-page",
                "priceSourceUrl": source_url,
                "priceScrapedAt": scraped_at,
                "priceNote":      f"Category starting price from community page ({scraped_at})",
            })
    return sorted(models, key=lambda x: x["priceFrom"])


def parse_name(text: str, fallback: str) -> str:  # noqa
    # Page title is usually first meaningful token before " - Richcraft Homes"
    m = re.match(r"^(.+?)\s+-\s+Richcraft Homes", text)
    if m:
        return m.group(1).strip()
    return fallback


def parse_description(text: str) -> Optional[str]:
    # "Welcome to <Name>\n<description text>"
    m = re.search(r"Welcome to .{3,60?}\s+(.{60,600}?)\s+Register Contact", text)
    if m:
        return m.group(1).strip()
    return None


def detect_status(text: str) -> str:
    lc = text.lower()
    if "sold out" in lc or "sold-out" in lc:
        return "sold-out"
    if "coming soon" in lc or "register now" in lc:
        return "upcoming"
    if "from $" in lc:
        return "selling"
    return "selling"


def infer_home_types(models: List[dict]) -> List[str]:
    seen = []
    label_map = {
        "Townhouse": ["Thrive Towns", "Urban Towns", "Bungalow Towns", "Townhomes"],
        "Single Family": ["Single Family Homes", "Bungalows"],
        "Condo": ["Flats"],
    }
    # Preserve model name labels directly
    for m in models:
        if m["name"] not in seen:
            seen.append(m["name"])
    return seen


def infer_type(models: List[dict]) -> str:
    types = {m["type"].lower() for m in models}
    if len(types) > 1:
        return "mixed"
    if not types:
        return "mixed"
    return types.pop()


# ─────────────────────────────────────────────
# Main scrape
# ─────────────────────────────────────────────

def scrape_community(cfg: dict) -> Tuple[Optional[dict], Optional[str]]:
    """
    Returns (build_dict, error_message).
    build_dict is None if fetch or parse fails.
    """
    html, err = fetch(cfg["url"])
    if err:
        return None, err

    text = strip_tags(html)

    scraped_at = str(date.today())
    models = parse_products(text, cfg["url"], scraped_at)
    if not models:
        return None, "No product/price lines found — page structure may have changed"

    name        = parse_name(text, cfg["id"].replace("richcraft-", "").replace("-", " ").title())
    description = parse_description(text)
    status      = detect_status(text)
    price_from  = models[0]["priceFrom"]
    home_types  = infer_home_types(models)
    build_type  = infer_type(models)

    build = {
        "id":                cfg["id"],
        "name":              name,
        "builder":           "Richcraft Homes",
        "community":         cfg["community"],
        "address":           cfg["address"],
        "lat":               cfg["lat"],
        "lng":               cfg["lng"],
        "status":            status,
        "type":              build_type,
        "homeTypes":         home_types,
        "priceFrom":         price_from,
        "priceFromFormatted": f"${price_from:,}",
        "completionYear":    None,
        "description":       description,
        "models":            models,
        "sourceUrl":         cfg["url"],
        "sourceName":        "Richcraft Homes",
        "scrapedAt":         scraped_at,
        # ── provenance summary ──
        "priceSource":       "community-page",
        "priceSourceUrl":    cfg["url"],
        "priceNote":         "Category-level starting prices from community landing page. Individual model pages may differ.",
    }
    return build, None


# ─────────────────────────────────────────────
# builds.json updater
# ─────────────────────────────────────────────

def update_builds_json(scraped: List[dict]) -> None:
    with open(BUILDS_JSON) as f:
        data = json.load(f)

    builds = data["builds"]
    existing = {b["id"]: i for i, b in enumerate(builds)}

    added = updated = 0
    for build in scraped:
        if build["id"] in existing:
            builds[existing[build["id"]]] = build
            updated += 1
        else:
            builds.append(build)
            added += 1

    data["count"] = len(builds)

    with open(BUILDS_JSON, "w") as f:
        json.dump(data, f, indent=2)

    print(f"  builds.json → {added} added, {updated} updated, {len(builds)} total")


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

def main():
    today = str(date.today())
    log = []
    scraped = []
    ok_count = 0
    fail_count = 0

    print(f"\nRichcraft scraper — {today}")
    print("=" * 50)

    for cfg in COMMUNITIES:
        print(f"\n[{cfg['id']}]")
        print(f"  URL: {cfg['url']}")

        build, err = scrape_community(cfg)

        if err:
            fail_count += 1
            msg = f"FAIL: {err}"
            print(f"  {msg}")
            log.append({"id": cfg["id"], "url": cfg["url"], "status": "fail", "error": err, "date": today})
        else:
            ok_count += 1
            models_summary = ", ".join(f"{m['name']} ${m['priceFrom']:,}" for m in build["models"])
            print(f"  OK  — {build['name']}, from ${build['priceFrom']:,}")
            print(f"  Models: {models_summary}")
            log.append({"id": cfg["id"], "url": cfg["url"], "status": "ok", "priceFrom": build["priceFrom"], "date": today})
            scraped.append(build)

        time.sleep(0.8)   # polite delay

    print("\n" + "=" * 50)
    print(f"Results: {ok_count} OK, {fail_count} FAILED")

    if scraped:
        print("\nUpdating builds.json...")
        update_builds_json(scraped)
    else:
        print("\nNo successful scrapes — builds.json not modified.")

    # Save log
    log_path = Path(__file__).parent / "richcraft_scrape_log.json"
    # Merge with existing log (keep last 20 runs per community)
    existing_log = []
    if log_path.exists():
        with open(log_path) as f:
            existing_log = json.load(f)

    existing_log.extend(log)
    # Keep only the last 20 entries per community id
    from collections import defaultdict
    by_id = defaultdict(list)
    for entry in existing_log:
        by_id[entry["id"]].append(entry)
    merged = []
    for entries in by_id.values():
        merged.extend(entries[-20:])
    merged.sort(key=lambda x: (x["date"], x["id"]))

    with open(log_path, "w") as f:
        json.dump(merged, f, indent=2)

    print(f"Log saved → {log_path}")

    if fail_count:
        print(f"\n⚠  {fail_count} communities failed. Check richcraft_scrape_log.json for details.")
        print("   Possible causes: URL changed, page redesigned, site blocking requests.")


if __name__ == "__main__":
    main()
