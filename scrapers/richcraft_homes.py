#!/usr/bin/env python3
"""
Richcraft /homes/ scraper — scrapes individual model specs (sqft, lot, beds,
baths, garage, sold-out status) from each community's /homes/ listing page.

Updates existing model entries in builds.json in-place (merges by name).
Does NOT overwrite prices — those come from richcraft.py (community page).

Usage:
    python3 scrapers/richcraft_homes.py

Run from /Users/xingsbot/NewBuildMap/
"""

import json
import re
import time
import urllib.request
from datetime import date
from pathlib import Path
from typing import Optional, Tuple, List
from collections import defaultdict

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────

BUILDS_JSON = Path(__file__).parent.parent / "public" / "data" / "builds.json"

COMMUNITIES = [
    {
        "id":        "richcraft-pathways",
        "homes_url": "https://www.richcraft.com/community/ottawa-south/pathways/homes/",
    },
    {
        "id":        "richcraft-riverside-south",
        "homes_url": "https://www.richcraft.com/community/ottawa-south/riverside-south/homes/",
    },
    {
        "id":        "richcraft-bradley-commons",
        "homes_url": "https://www.richcraft.com/community/ottawa-west/bradley_commons/homes/",
    },
    {
        "id":        "richcraft-mapleton",
        "homes_url": "https://www.richcraft.com/community/ottawa-west/mapleton/homes/",
    },
    {
        "id":        "richcraft-westwood",
        "homes_url": "https://www.richcraft.com/community/ottawa-west/westwood/homes/",
    },
    {
        "id":        "richcraft-kanata-lakes",
        "homes_url": "https://www.richcraft.com/community/ottawa-west/kanata-lakes/homes/",
    },
    {
        "id":        "richcraft-gateway-flats",
        "homes_url": "https://www.richcraft.com/community/ottawa-west/gateway-flats/homes/",
    },
    {
        "id":        "richcraft-trailsedge",
        "homes_url": "https://www.richcraft.com/community/ottawa-east/trailsedge/homes/",
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
# Garage IDs → count/type map (from Richcraft's JS)
# ─────────────────────────────────────────────
GARAGE_MAP = {
    "20": 1,   # single
    "21": 2,   # double (standard)
    "22": 2,   # double (oversized/tandem)
    "23": 3,   # triple
}

# ─────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────

def fetch(url: str) -> Tuple[Optional[str], Optional[str]]:
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


def strip_tags(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# ─────────────────────────────────────────────
# Model type detector from context
# Richcraft /homes/ page groups models under headings:
# "Single Family", "Bungalows", "Townhomes", "Thrive Towns",
# "Urban Towns", "Bungalow Towns", "Multi-Gen", "Tandem"
# ─────────────────────────────────────────────

TYPE_HEADINGS = [
    "Tandem", "Multi-Gen", "Bungalow Towns", "Urban Towns",
    "Thrive Towns", "Bungalows", "Townhomes", "Single Family", "Flats",
]

# ─────────────────────────────────────────────
# Parse /homes/ text into model list
# ─────────────────────────────────────────────

# Pattern matches a model block like:
# [Temporarily Sold Out] <Name> <sqft> SQ FT [| <lot> FT LOT] View Model --> [-->] <beds> <baths> Garage IDs: <ids>
MODEL_RE = re.compile(
    r"(?P<soldout>Temporarily Sold Out\s+)?"
    r"(?P<name>[A-Z][A-Za-z0-9 \-/]+?)\s+"
    r"(?P<sqft>[\d,/]+)\s+SQ\s*FT"
    r"(?:\s*\|\s*(?P<lot>\d+)\s*FT\s*LOT)?"
    r"\s+View Model\s*(?:-->)?\s*(?:-->)?\s*(?:-->)?"
    r"\s+(?P<beds>[\d\+/]+)\s+"
    r"(?P<baths>[\d\.]+)\s+"
    r"Garage\s+IDs:\s+(?P<garage_ids>[\d\s]+?)(?=-->|[A-Z][a-z]|$)"
)


def parse_beds(raw: str) -> Optional[int]:
    """'3+' → 3,  '3/4' → 3,  '3' → 3"""
    if not raw:
        return None
    m = re.match(r"(\d+)", raw.strip())
    return int(m.group(1)) if m else None


def parse_sqft(raw: str) -> Optional[int]:
    """'1921/1922' → 1921,  '1185' → 1185"""
    if not raw:
        return None
    m = re.match(r"([\d,]+)", raw.replace(",", ""))
    return int(m.group(1)) if m else None


def parse_baths(raw: str) -> Optional[float]:
    if not raw:
        return None
    raw = raw.strip()
    # Handle ranges like "3.5/4.5" — take the lower value
    if '/' in raw:
        raw = raw.split('/')[0]
    try:
        return float(raw)
    except ValueError:
        return None


def parse_garages(raw: str) -> Optional[int]:
    if not raw:
        return None
    ids = raw.strip().split()
    # Take the first garage ID's mapped count
    for gid in ids:
        gid = gid.strip()
        if gid in GARAGE_MAP:
            return GARAGE_MAP[gid]
    return None


def detect_type_for_model(name: str, text_before: str) -> str:
    """
    Walk backwards through the text preceding this model name
    and find the nearest type heading.
    """
    best_pos = -1
    best_type = "Single Family"
    for heading in TYPE_HEADINGS:
        pos = text_before.rfind(heading)
        if pos > best_pos:
            best_pos = pos
            best_type = heading
    return best_type


def parse_homes_page(html: str, source_url: str, scraped_at: str) -> List[dict]:
    """
    Parse each .home-listing card by extracting its opening tag attributes,
    then finding name/URL/sold-out within the bounded card body.

    Each card's opening tag contains all spec data attributes.
    The card body (until the next home-listing or end of grid) has the name and status.
    """
    models = []
    seen_names = set()

    # Split on outer .home-card wrappers so the body of each card includes
    # ALL nested divs (home-listing-img, home-listing-content with the <h3>, etc.)
    # The structure is:
    #   <div class="cell medium-6 large-4 home-card">
    #     <div class="home-listing" data-sqft-min="..." data-bedrooms="..." ...>
    #       <a class="abs-link" ...></a>
    #       <div class="home-listing-img" ...>...</div>
    #       <div class="home-listing-content"><h3>Model Name</h3>...</div>
    #       <div class="home-listing-footer">...</div>
    card_splits = list(re.finditer(
        r'<div[^>]+class="[^"]*\bhome-card\b[^"]*">(.*?)(?=<div[^>]+class="[^"]*\bhome-card\b|$)',
        html, re.DOTALL
    ))

    for i, card_start in enumerate(card_splits):
        body = card_start.group(1)

        # Extract the home-listing opening tag — has all the spec data attributes
        listing_m = re.search(
            r'<div[^>]+class="[^"]*\bhome-listing\b[^"]*"(.*?)>',
            body, re.DOTALL
        )
        if not listing_m:
            continue
        attrs_str = listing_m.group(1)

        def attr(pattern):
            m = re.search(pattern, attrs_str)
            return m.group(1) if m else None

        sqft_raw  = attr(r'data-sqft-min=["\'](\d+)["\']')
        type_raw  = None  # read from body below
        price_raw = attr(r'data-price-min=["\'](\d+)["\']')
        gar_raw   = attr(r'data-garages=["\'](\d+)["\']')
        beds_raw  = attr(r'data-bedrooms=["\'](\d+)["\']')
        baths_raw = attr(r'data-bathrooms=["\']([^"\']*)["\']')
        lot_raw   = attr(r'data-lot-size=["\'](\d+)["\']')

        # Name from <h3>
        name_m = re.search(r'<h3>([^<]+)</h3>', body)
        if not name_m:
            continue
        name = name_m.group(1).strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)

        # Model URL from abs-link
        url_m = re.search(r'<a href="(https://www\.richcraft\.com/home/[^"]+)"[^>]*class="abs-link"', body)
        model_url = url_m.group(1) if url_m else f"https://www.richcraft.com/home/{name.lower().replace(' ', '-')}/"

        # Image URL
        img_m = re.search(r'background-image:\s*url\(([^)]+)\)', body)
        img_url = img_m.group(1) if img_m else None

        # Type from icon-list ul
        type_m = re.search(r'<ul[^>]+class="icon-list"[^>]+data-type="([^"]+)"', body)
        if not type_m:
            type_m = re.search(r'data-type="([^"]+)"', body)
        type_raw = type_m.group(1).strip() if type_m else None

        # Sold out
        sold_out = bool(re.search(r'sold.?out|Temporarily\s+Sold\s+Out', body, re.IGNORECASE))

        models.append({
            "name":           name,
            "type":           type_raw or "Single Family",
            "sqft":           int(sqft_raw) if sqft_raw else None,
            "beds":           int(beds_raw) if beds_raw else None,
            "baths":          parse_baths(baths_raw),
            "lotWidth":       int(lot_raw) if lot_raw else None,
            "garages":        int(gar_raw) if gar_raw else None,
            "priceFrom":      int(price_raw) if price_raw else None,
            "status":         "sold-out" if sold_out else "available",
            "modelUrl":       model_url,
            "localImageUrl":  img_url,
            # provenance
            "specsSource":    "homes-page",
            "specsSourceUrl": source_url,
            "specsScrapedAt": scraped_at,
        })

    return sorted(models, key=lambda x: (x.get("sqft") or 99999))


# ─────────────────────────────────────────────
# Merge scraped specs into existing build models
# Strategy:
#   - Match by name (case-insensitive)
#   - Update: sqft, beds, baths, lotWidth, garages, status, modelUrl, provenance
#   - Preserve: priceFrom, priceSource, localImageUrl (from previous scrapes)
#   - Add new models not previously known
# ─────────────────────────────────────────────

def merge_models(existing: List[dict], scraped: List[dict]) -> List[dict]:
    existing_by_name = {m["name"].lower(): m for m in existing}
    scraped_by_name  = {m["name"].lower(): m for m in scraped}

    result = []

    # Update or add scraped models
    for name_lc, sm in scraped_by_name.items():
        if name_lc in existing_by_name:
            em = dict(existing_by_name[name_lc])
            # Update specs, preserve price + image
            em.update({
                "type":           sm["type"],
                "sqft":           sm["sqft"],
                "beds":           sm["beds"],
                "baths":          sm["baths"],
                "lotWidth":       sm["lotWidth"],
                "garages":        sm["garages"],
                "status":         sm["status"],
                "modelUrl":       sm["modelUrl"],
                "specsSource":    sm["specsSource"],
                "specsSourceUrl": sm["specsSourceUrl"],
                "specsScrapedAt": sm["specsScrapedAt"],
            })
            # Update image if scraped has one and existing doesn't (or still remote URL)
            if sm.get("localImageUrl"):
                em["localImageUrl"] = sm["localImageUrl"]
            result.append(em)
        else:
            result.append(sm)

    # Keep existing models not found on /homes/ (may have been removed)
    for name_lc, em in existing_by_name.items():
        if name_lc not in scraped_by_name:
            em = dict(em)
            em["status"] = em.get("status", "unknown")
            result.append(em)

    # Sort by sqft
    result.sort(key=lambda x: (x.get("sqft") or 99999))
    return result


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main():
    today = str(date.today())
    log = []
    ok_count = fail_count = 0

    with open(BUILDS_JSON) as f:
        data = json.load(f)
    builds_by_id = {b["id"]: b for b in data["builds"]}

    print(f"\nRichcraft /homes/ scraper — {today}")
    print("=" * 50)

    for cfg in COMMUNITIES:
        bid = cfg["id"]
        url = cfg["homes_url"]
        print(f"\n[{bid}]")
        print(f"  URL: {url}")

        html, err = fetch(url)
        if err:
            fail_count += 1
            print(f"  FAIL: {err}")
            log.append({"id": bid, "url": url, "status": "fail", "error": err, "date": today})
            continue

        models = parse_homes_page(html, url, today)

        if not models:
            fail_count += 1
            msg = "No models parsed — page structure may have changed"
            print(f"  FAIL: {msg}")
            log.append({"id": bid, "url": url, "status": "fail", "error": msg, "date": today})
            continue

        ok_count += 1
        print(f"  OK  — {len(models)} models parsed")

        # Type breakdown
        by_type = defaultdict(int)
        for m in models:
            by_type[m["type"]] += 1
        for t, c in sorted(by_type.items()):
            sold = sum(1 for m in models if m["type"] == t and m.get("status") == "sold-out")
            print(f"    {t}: {c} models ({sold} sold out)")

        # Merge into existing build
        if bid in builds_by_id:
            existing_models = builds_by_id[bid].get("models", [])
            merged = merge_models(existing_models, models)
            builds_by_id[bid]["models"]  = merged
            builds_by_id[bid]["scrapedAt"] = today
            print(f"  Merged into {bid} ({len(existing_models)} → {len(merged)} models)")
        else:
            print(f"  WARNING: build id '{bid}' not found in builds.json — skipping merge")

        log.append({
            "id": bid, "url": url, "status": "ok",
            "modelsFound": len(models), "date": today,
        })
        time.sleep(0.8)

    # Write back
    data["builds"] = list(builds_by_id.values())
    with open(BUILDS_JSON, "w") as f:
        json.dump(data, f, indent=2)

    print(f"\n{'='*50}")
    print(f"Results: {ok_count} OK, {fail_count} FAILED")
    print(f"builds.json updated — {len(data['builds'])} total builds")

    # Save log
    log_path = Path(__file__).parent / "richcraft_homes_log.json"
    existing_log = []
    if log_path.exists():
        with open(log_path) as f:
            existing_log = json.load(f)
    existing_log.extend(log)
    by_id = defaultdict(list)
    for entry in existing_log:
        by_id[entry["id"]].append(entry)
    merged_log = []
    for entries in by_id.values():
        merged_log.extend(entries[-20:])
    merged_log.sort(key=lambda x: (x["date"], x["id"]))
    with open(log_path, "w") as f:
        json.dump(merged_log, f, indent=2)
    print(f"Log saved → {log_path}")

    if fail_count:
        print(f"\n⚠  {fail_count} communities failed. Check richcraft_homes_log.json.")


if __name__ == "__main__":
    main()
