# 🔒 Coordinate Lock Protocol

**All community coordinates are LOCKED as of 2026-04-18**

## Why This Matters

Community locations were manually verified and geocoded using Google Maps API. These coordinates must NEVER be changed by automated scrapers or bulk updates.

---

## The Lock System

- **Lock file**: `.coordinate-lock.json` — Contains the definitive lat/lng for each community
- **Locked communities**: 55 (all current communities)

---

## Strict Rules

### ✅ ALLOWED
- Update prices, models, features
- Add new communities (their coordinates will NOT be locked unless manually geocoded)
- Update descriptions, images, status

### ❌ FORBIDDEN
- Change coordinates of existing communities
- Re-run scrapers without coordinate restoration
- Modify `.coordinate-lock.json` without explicit approval

---

## Workflow for Updates

**NEVER do this:**
```bash
npm run scrape  # ❌ NO! Will overwrite coordinates
```

**ALWAYS do this:**
```bash
npm run scrape             # Run scraper (updates data)
node scripts/restore-coordinates.js  # ✅ RESTORE coordinates immediately
```

---

## Emergency: If Coordinates Get Changed

Restore them immediately:
```bash
node scripts/restore-coordinates.js
```

Then commit:
```bash
git add public/data/builds.json
git commit -m "Restore locked coordinates"
```

---

## Adding New Communities

1. Add new community data to builds.json (via scraper or manual)
2. Geocode new communities using Google Maps API:
   ```bash
   node scripts/geocode-all.js
   ```
3. Update the lock file with new coordinates:
   ```bash
   node scripts/protect-coordinates.js
   ```
4. Commit both `.coordinate-lock.json` and `public/data/builds.json`

---

## Disabling Lock (Not Recommended)

Only if you have explicit approval to re-geocode all communities:

1. Delete `.coordinate-lock.json`
2. Run `node scripts/geocode-all.js`
3. Create new lock: `node scripts/protect-coordinates.js`
4. Commit with detailed explanation

---

**Last Updated**: 2026-04-18  
**Locked Communities**: 55  
**Locked Coordinates**: 55
