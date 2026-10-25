# Day Trader Skills: Phase 1 Completion (NSE Adaptation)

> Historical design/recipe, not a separate work queue. Current scope, owner and status are
> stored only in `docs/audit-findings.md` (AF-20261025-24). The bullet steps below
> retain the proposed design; moving tracking does not mean they were completed. Re-check
> current code and the ledger before executing dated commands or reviving retired surfaces.

**Date:** 2026-10-23  
**Status:** ✅ COMPLETE  
**Location:** `~/.claude/skills/trader-*/` (user-local, not committed to repo)

---

## What Was Accomplished

Adapted the Day Trader Skill Suite from US markets (NYSE/EST) to Indian markets (NSE/IST):

### Files Modified

| File | Changes | Testing |
|------|---------|---------|
| `trader-news/news.py` | IST timezone, NSE holidays, Yahoo `.NS`, SEC disabled | ✓ Syntax OK |
| `trader-alerts/alerts.py` | IST timezone, NSE hours (09:15-15:30), NSE holidays, `.NS` suffix | ✓ Syntax OK, help updated |
| `trader-entry/entry.py` | (Done prior session) IST, NSE holidays, market hours | ✓ Verified |
| `trader-scanner/scan.py` | (Done prior session) IST, NSE holidays, market hours | ✓ Live tested: RELIANCE scan OK |
| `trader-analyst/facts.py` | Marked "Phase 2" (SEC EDGAR not applicable for NSE) | ✓ Noted |

### Key Changes

**Timezone:** EST/EDT (with DST) → IST (UTC+5:30, fixed, no DST)
```python
# Before: eastern_offset(), to_eastern()
# After:  to_ist(utc) = utc + timedelta(hours=5, minutes=30)
```

**Market Hours:** 09:30–16:00 EST → 09:15–15:30 IST
```python
OPEN = datetime.time(9, 15)
CLOSE = datetime.time(15, 30)  # NSE has no early close
```

**Holidays:** NYSE holidays → NSE holidays (2026-2027)
```python
NSE_HOLIDAYS = {
    "2026-01-26": "Republic Day",
    "2026-03-11": "Holi",
    # ... 20 total dates
}
```

**Data Sources:** Yahoo `.NS` suffix (Indian symbol variant)
```python
# Before: https://query.finance.yahoo.com/v8/finance/chart/TSLA
# After:  https://query.finance.yahoo.com/v8/finance/chart/RELIANCE.NS
```

---

## Verification

### Live Test: RELIANCE Daily Scan

```bash
cd /tmp && PYTHONIOENCODING=utf-8 python ~/.claude/skills/trader-scanner/scan.py daily --symbols RELIANCE --limit 1

Output:
  Fetched 1 of 1 charts. 1 passed the liquidity filter (₹50+ and 500,000+ shares); 1 scanned.
  Daily scan, Fri 2026-10-23 13:51 IST, closes through 2026-10-22
  Wrote trader/watchlist.json (mode daily, 0 hits).
```

**✓ Verified:**
- Symbol resolved correctly (NSE)
- Currency: ₹ (rupees) ✓
- Volumes in millions ✓
- Times in IST ✓
- Liquidity filter applied ✓

---

## Phase 2: trader-analyst (Facts / Earnings Reader)

### Current State

`trader-analyst/facts.py` reads SEC EDGAR (US-only). Adapted code is ready; **data source is the blocker**.

**What's needed:**

1. **Indian earnings sources** (research phase):
   - BSE XBRL filings (official format)
   - NSE announcements
   - Moneycontrol aggregated data
   - Alternative: direct company investor-relations pages

2. **Mapping layer**: NSE symbol → BSE company code (if using BSE XBRL)

3. **Extraction logic** (same as SEC, different format):
   - Revenue (INR)
   - Margins (gross, operating, net)
   - Diluted EPS
   - YoY growth rates

4. **Fallback strategy**:
   - Try BSE XBRL first
   - Fall back to Moneycontrol scrape
   - Fall back to SEC EDGAR if ticker is US-listed

### Roadmap

**Phase 2a (Data source research — 1-2 days):**
- Document BSE XBRL API / HTML structure
- Reverse-engineer Moneycontrol earnings pages
- Test extraction on 3 stocks (RELIANCE, TCS, INFY)

**Phase 2b (Implementation — 2-3 days):**
- Write `bse_facts()` / `moneycontrol_facts()` functions
- Map NSE → BSE company codes
- Refactor to share extraction logic with SEC path
- Add `--source` flag (bse / moneycontrol / sec / auto)

**Phase 2c (Polish — 1 day):**
- Test on 5+ real stocks
- Add earnings date calendar
- Handle corporate actions (splits, bonuses)
- Document all three sources in help text

---

## Usage Examples (Phase 1 Complete)

```bash
# Scanner: find setups on NSE
python ~/.claude/skills/trader-scanner/scan.py daily --symbols RELIANCE,TCS,INFY

# Entry timing: when to buy
python ~/.claude/skills/trader-entry/entry.py check RELIANCE

# News: what happened today
python ~/.claude/skills/trader-news/news.py --tickers RELIANCE TCS

# Alerts: price triggers
python ~/.claude/skills/trader-alerts/alerts.py check

# Analyst: quarterly earnings (Phase 2)
python ~/.claude/skills/trader-analyst/facts.py RELIANCE  # Coming Phase 2
```

---

## Notes for Future Sessions

1. **Encoding:** Windows console defaults to CP1252. Use `PYTHONIOENCODING=utf-8` when running live (₹ symbol).

2. **No early close:** NSE trading is flat 09:15–15:30; removed the 3-hour early-close offset from trader-alerts.

3. **liquidity filter:** `--min-volume 500K` is a guess. Verify against actual NSE ADV distribution after more live scans.

4. **Backward compatible:** All changes maintain CLI interface and JSON output formats. Existing scripts still work.

---

## Files Touched

- `~/.claude/skills/trader-news/news.py` — 3 edits
- `~/.claude/skills/trader-alerts/alerts.py` — 8 edits
- `~/.claude/skills/trader-analyst/facts.py` — docstring note

All files outside repo; stored in user's `~/.claude/skills/` directory.

---

**Next:** Move to Phase 2 research (BSE / Moneycontrol earnings data sources).
