# Phase 2: trader-analyst — Indian Earnings Data Integration

> Historical design/recipe, not a separate work queue. Current scope, owner and status are
> stored only in `docs/audit-findings.md` (AF-20261025-24). The bullet steps below
> retain the proposed design; moving tracking does not mean they were completed. Re-check
> current code and the ledger before executing dated commands or reviving retired surfaces.

**Objective:** Adapt `trader-analyst/facts.py` from SEC EDGAR (US) to support NSE/BSE earnings (India)

**Timeline:** 2-4 days (depends on data source availability)

---

## 1. Research Phase (Day 1)

### 1.1 BSE XBRL Format

**Goal:** Can we extract earnings from official BSE filings?

**Tasks:**
- Visit https://www.bseindia.com/ and explore filing structure
- Locate one company's quarterly filing (e.g., RELIANCE, TCS)
- Check if XBRL is machine-readable or HTML-only
- Document URL pattern: `https://www.bseindia.com/.../<company>/<filing>/...`
- Extract sample: revenue, net income, EPS from one quarter

**Reference:** SEC EDGAR is fully machine-readable JSON/XBRL. BSE may be HTML-heavy.

### 1.2 Moneycontrol Earnings Pages

**Goal:** Can we scrape/parse Moneycontrol's aggregated financials?

**Tasks:**
- Open Moneycontrol (e.g., https://www.moneycontrol.com/stocks/companyinfo/reliance/)
- Locate quarterly financials table
- Reverse-engineer page structure (HTML selectors, table format)
- Test extraction on 3 stocks (RELIANCE, TCS, INFY)
- Document: CSS selectors, column order, date format

**Reference:** May be faster than BSE if Moneycontrol is consistent. Risk: site redesigns break scraper.

### 1.3 NSE Investor Relations

**Goal:** Are there official APIs or downloadable files?

**Tasks:**
- Check https://www.nseindia.com/ for data portal / APIs
- Search for company investor-relations links (IRL pages)
- Check if NSE publishes consolidated earnings calendars
- Document: API endpoints, auth requirements, data format

**Reference:** Most unlikely to have APIs; mostly manual links per company.

### 1.4 Data Mapping

**Goal:** NSE symbol → BSE company code

**Tasks:**
- Check if nse_stocks table has BSE mapping (grep schema, run query)
- If missing, build mapping: NSE symbol → BSE company code
- Test on 5 symbols (RELIANCE, TCS, INFY, M&M, BAJAJ-AUTO)
- Document: lookup table / SQL / API endpoint

**Reference:** You have ~2,400 NSE symbols. Mapping is a one-time task.

---

## 2. Implementation Phase (Days 2-3)

### 2.1 Data Source Module

Create `~/.claude/skills/trader-analyst/earnings_sources.py`:

```python
# Module: earnings_sources.py

class EarningsSource(ABC):
    """Base class for earnings data providers."""
    @abstractmethod
    def get_facts(self, symbol: str) -> Dict:
        """Return {ticker, currency, quarters: [{period, revenue, eps_diluted, ...}]}"""
        pass

class BSEXBRLSource(EarningsSource):
    """Fetch from official BSE filings."""
    def get_facts(self, nse_symbol):
        bse_code = nse_to_bse(nse_symbol)
        url = f"https://www.bseindia.com/.../{bse_code}/..."
        # Parse XBRL/HTML → extract revenue, eps, margins
        # Return standardized dict

class MoneycontrolSource(EarningsSource):
    """Fallback: scrape Moneycontrol aggregated data."""
    def get_facts(self, symbol):
        url = f"https://www.moneycontrol.com/stocks/companyinfo/{symbol.lower()}/"
        # Fetch HTML, parse table
        # Return standardized dict

class SECSource(EarningsSource):
    """Existing SEC EDGAR source (US stocks only)."""
    # (existing code from facts.py)
```

### 2.2 Refactor facts.py

```python
# In facts.py main():

def facts_for_nse(symbol, sources=["bse", "moneycontrol"]):
    """Try sources in order, return first success."""
    for source_name in sources:
        try:
            if source_name == "bse":
                source = BSEXBRLSource()
            elif source_name == "moneycontrol":
                source = MoneycontrolSource()
            elif source_name == "sec":
                source = SECSource()
            
            return source.get_facts(symbol)
        except EarningsError:
            continue
    
    raise EarningsError(f"No earnings data found for {symbol}")

# Main entry point:
if __name__ == "__main__":
    for ticker in args.tickers:
        try:
            if is_nse_symbol(ticker):
                facts = facts_for_nse(ticker, sources=args.source.split(","))
            else:
                facts = SECSource().get_facts(ticker)
            render(facts)
        except EarningsError as e:
            print(f"Error: {ticker}: {e}", file=sys.stderr)
```

### 2.3 CLI Enhancement

Add flags to facts.py:

```bash
python facts.py RELIANCE --source bse,moneycontrol,sec  # Try in order
python facts.py RELIANCE --source moneycontrol          # Force Moneycontrol
python facts.py AAPL --source sec                       # US: force SEC
python facts.py RELIANCE --quarters 12                  # Last 12 quarters
python facts.py RELIANCE TCS INFY --metrics output.json # Bulk export
```

---

## 3. Testing Phase (Day 3-4)

### 3.1 Unit Tests

```python
# tests/test_bse_facts.py
def test_bse_reliance():
    source = BSEXBRLSource()
    facts = source.get_facts("RELIANCE")
    assert facts["currency"] == "INR"
    assert facts["quarters"][0]["revenue"] > 0
    assert facts["quarters"][0]["eps_diluted"] > 0

def test_moneycontrol_fallback():
    source = MoneycontrolSource()
    facts = source.get_facts("TCS")
    assert facts["ticker"] == "TCS"
    assert len(facts["quarters"]) >= 4

def test_nse_to_bse_mapping():
    assert nse_to_bse("RELIANCE") == "500325"
    assert nse_to_bse("TCS") == "532540"
    # ... 20+ more mappings
```

### 3.2 Live Tests

```bash
python facts.py RELIANCE          # Should print quarterly financials
python facts.py TCS INFY          # Bulk test, 2 stocks
python facts.py RELIANCE --json   # JSON output format
python facts.py RELIANCE --metrics out.json  # Metrics export
```

**Expected Output:**

```
RELIANCE Financials (₹ billions)
Q3 2026: Revenue 1,850.2B | Net Income 185.0B | EPS 89.50 | Growth 12.3% YoY
Q2 2026: Revenue 1,823.5B | Net Income 178.4B | EPS 86.10 | Growth 11.8% YoY
Q1 2026: Revenue 1,801.8B | Net Income 175.2B | EPS 84.70 | Growth 11.2% YoY
...
```

---

## 4. Polish Phase (Day 4)

### 4.1 Documentation

Update help text:

```python
"""
Earnings reader for NSE stocks (and US via SEC fallback).

Sources:
  bse       Official BSE XBRL filings (primary for NSE)
  moneycontrol  Aggregated financials from Moneycontrol (faster, less reliable)
  sec       SEC EDGAR (US stocks only)

Usage:
  python facts.py RELIANCE              # NSE: tries BSE → Moneycontrol
  python facts.py AAPL --source sec     # US: SEC EDGAR only
  python facts.py RELIANCE TCS INFY     # Bulk: all NSE
"""
```

### 4.2 Corporate Actions Calendar

**Optional enhancement:** Add earnings dates + ex-dividend dates

```python
def earnings_calendar(symbol):
    """Return list of announced earnings dates for next 12 months."""
    # Fetch from NSE announcements / company IR pages
    return [
        {"date": "2026-11-15", "quarter": "Q3 2026", "actual_date": None},
        {"date": "2027-02-28", "quarter": "Q4 2026", "actual_date": None},
    ]
```

### 4.3 Error Handling

Graceful degradation:

```python
# If BSE XBRL is unavailable:
try:
    facts = BSEXBRLSource().get_facts(symbol)
except HTTPError as e:
    if e.status == 404:
        print(f"No XBRL filing for {symbol}. Trying Moneycontrol...", file=sys.stderr)
        facts = MoneycontrolSource().get_facts(symbol)
except Exception as e:
    raise EarningsError(f"No data found: {e}")
```

---

## 5. Success Criteria

- `python facts.py RELIANCE` returns 8+ quarters of financials (INR)
- `python facts.py TCS INFY` bulk-exports metrics to JSON
- `python facts.py AAPL --source sec` still works (backward compat)
- Unit tests pass (BSE extraction, Moneycontrol fallback, mapping)
- Help text documents all sources and flags
- No external dependencies beyond stdlib (keep "Standard library only" rule)

---

## 6. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| BSE XBRL format changes | Data extraction breaks | Robust HTML parsing + fallback to Moneycontrol |
| Moneycontrol redesigns | Scraper breaks | Monitor CSS selectors, add version flags |
| NSE symbol ↔ BSE code gaps | Mapping failures | 100% test coverage on known symbols |
| Rate limiting (Moneycontrol) | Blocks requests | Add `--pause` flag, exponential backoff |
| No earnings data | Script fails | Return "N/A" for missing quarters (don't crash) |

---

## 7. Timeline & Ownership

| Task | Days | Owner |
|------|------|-------|
| 1. Research BSE/Moneycontrol/NSE | 1 | (this session) |
| 2. Build earnings_sources.py module | 1 | (this session) |
| 3. Refactor facts.py + add flags | 0.5 | (this session) |
| 4. Write unit tests | 0.5 | (this session) |
| 5. Live testing (3+ stocks) | 0.5 | (next session) |
| 6. Polish + docs | 0.5 | (next session) |

**Total:** 4 days (2 dev + 2 test/polish)

---

## 8. Deliverables

**End of Phase 2:**

- ✅ `trader-analyst/facts.py` supports NSE via BSE/Moneycontrol
- ✅ Backward compatible (SEC EDGAR still works for US stocks)
- ✅ 10+ test vectors (NSE symbols + US symbols)
- ✅ Help text + CLI flags (--source, --quarters, --metrics)
- ✅ No additional dependencies (stdlib only)

**Status:** Phase 1 complete, Phase 2 ready to start.
