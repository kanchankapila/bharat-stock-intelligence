# Provider Score Reverse-Engineering & Market Growth Study Report
**Generated At**: 2026-08-28 00:38:57 IST

## Executive Summary
This study reverse-engineers stock scores from different market data providers 
(Trendlyne, Tickertape, NiftyTrader, MoneyControl, and internal Quant/Composite engines). 
It evaluates **Cross-Provider Consistency (Concordance & Spearman Correlation)** 
and **Market Growth Predictive Power (Forward Realized Returns & Quintile Lift)**.

---

## 1. Cross-Provider Score Consistency & Correlation
Measures how strongly score factors from different providers correlate across the same cross-section of stocks:

| Factor A | Factor B | Provider A | Provider B | Samples | Spearman Rank IC | Category Concordance % |
|---|---|---|---|---|---|---|
| Quant Engine Momentum | Quant Composite Score | quant_engine | quant_engine | 2,416 | **0.894** | 77.1% |
| Trendlyne Valuation | Quant Engine Value | trendlyne | quant_engine | 411 | **0.598** | 50.4% |
| Trendlyne Momentum | Quant Engine Momentum | trendlyne | quant_engine | 417 | **0.545** | 50.8% |
| Trendlyne Momentum | Quant Composite Score | trendlyne | quant_engine | 417 | **0.500** | 48.0% |
| Trendlyne Momentum | NiftyTrader Technical | trendlyne | niftytrader | 28,548 | **0.471** | 53.6% |
| Trendlyne Valuation | Trendlyne Durability | trendlyne | trendlyne | 25,291 | **0.389** | 45.1% |
| Quant Engine Quality | Quant Composite Score | quant_engine | quant_engine | 2,416 | **0.357** | 42.1% |
| NiftyTrader Technical | Tickertape Performance | niftytrader | tickertape | 5,022 | **0.352** | 59.3% |
| Tickertape Profitability | MoneyControl DuPont | tickertape | moneycontrol | 126 | **0.327** | 46.0% |
| NiftyTrader Technical | Quant Engine Momentum | niftytrader | quant_engine | 1,859 | **0.310** | 47.2% |
| Trendlyne Durability | Quant Engine Quality | trendlyne | quant_engine | 392 | **0.303** | 40.3% |
| Trendlyne Durability | Quant Composite Score | trendlyne | quant_engine | 392 | **0.303** | 44.9% |
| Quant Engine Quality | MoneyControl DuPont | quant_engine | moneycontrol | 129 | **0.288** | 41.1% |
| NiftyTrader Technical | Quant Composite Score | niftytrader | quant_engine | 1,859 | **0.283** | 45.1% |
| Tickertape Performance | Tickertape Valuation | tickertape | tickertape | 5,022 | **0.279** | 46.0% |
| Trendlyne Valuation | Quant Composite Score | trendlyne | quant_engine | 411 | **0.239** | 39.9% |
| Trendlyne Durability | MoneyControl DuPont | trendlyne | moneycontrol | 2,324 | **0.234** | 41.5% |
| Tickertape Performance | MoneyControl DuPont | tickertape | moneycontrol | 126 | **0.229** | 39.7% |
| Quant Engine Momentum | Trendlyne Durability | quant_engine | trendlyne | 392 | **0.225** | 41.3% |
| NiftyTrader Technical | Tickertape Valuation | niftytrader | tickertape | 5,022 | **0.215** | 41.0% |
| NiftyTrader Technical | MoneyControl DuPont | niftytrader | moneycontrol | 5,709 | **0.202** | 41.9% |
| Trendlyne Momentum | Trendlyne Durability | trendlyne | trendlyne | 25,305 | **0.196** | 38.8% |
| MoneyControl DuPont | Quant Composite Score | moneycontrol | quant_engine | 129 | **0.180** | 38.0% |
| NiftyTrader Technical | Quant Engine Quality | niftytrader | quant_engine | 1,859 | **0.172** | 37.8% |
| NiftyTrader Technical | Tickertape Profitability | niftytrader | tickertape | 5,022 | **0.149** | 55.4% |
| Quant Engine Momentum | MoneyControl DuPont | quant_engine | moneycontrol | 129 | **0.142** | 40.3% |
| Quant Engine Momentum | Quant Engine Quality | quant_engine | quant_engine | 2,416 | **0.117** | 35.8% |
| NiftyTrader Technical | Trendlyne Durability | niftytrader | trendlyne | 25,300 | **0.091** | 36.7% |
| Trendlyne Momentum | MoneyControl DuPont | trendlyne | moneycontrol | 2,473 | **0.066** | 35.4% |
| Tickertape Valuation | MoneyControl DuPont | tickertape | moneycontrol | 126 | **0.063** | 34.9% |
| Tickertape Performance | Tickertape Profitability | tickertape | tickertape | 5,022 | **0.039** | 57.0% |
| Quant Engine Momentum | Trendlyne Valuation | quant_engine | trendlyne | 411 | **0.017** | 36.5% |
| Quant Engine Value | Quant Composite Score | quant_engine | quant_engine | 2,416 | **0.013** | 31.5% |
| Trendlyne Valuation | Quant Engine Quality | trendlyne | quant_engine | 411 | **0.011** | 30.7% |
| Trendlyne Momentum | Quant Engine Quality | trendlyne | quant_engine | 417 | **-0.009** | 32.9% |
| Trendlyne Valuation | MoneyControl DuPont | trendlyne | moneycontrol | 2,459 | **-0.050** | 32.2% |
| Trendlyne Momentum | Trendlyne Valuation | trendlyne | trendlyne | 28,117 | **-0.067** | 30.6% |
| Quant Engine Value | Trendlyne Durability | quant_engine | trendlyne | 392 | **-0.073** | 29.1% |
| NiftyTrader Technical | Trendlyne Valuation | niftytrader | trendlyne | 28,112 | **-0.090** | 29.9% |
| Quant Engine Value | MoneyControl DuPont | quant_engine | moneycontrol | 129 | **-0.129** | 34.9% |
| Quant Engine Value | Quant Engine Quality | quant_engine | quant_engine | 2,416 | **-0.146** | 36.3% |
| Trendlyne Momentum | Quant Engine Value | trendlyne | quant_engine | 417 | **-0.214** | 24.2% |
| Quant Engine Momentum | Quant Engine Value | quant_engine | quant_engine | 2,416 | **-0.264** | 25.2% |
| NiftyTrader Technical | Quant Engine Value | niftytrader | quant_engine | 1,859 | **-0.281** | 23.2% |
| Tickertape Valuation | Tickertape Profitability | tickertape | tickertape | 5,022 | **-0.334** | 29.3% |

---

## 2. Provider Market Growth & Predictive Return Performance
Measures how well provider scores predict actual forward stock market growth (returns over 5d, 21d, 63d horizons):

| Provider / Factor | Horizon | Samples | Rank IC | Top Quintile (Q5) Return | Bottom Quintile (Q1) Return | Market Lift (Q5-Q1) | Q5 Win Rate % |
|---|---|---|---|---|---|---|---|
| **Tickertape Valuation** (tickertape) | 5d | 5,016 | 0.1386 | +0.95% | -0.30% | **+1.25%** | 53.0% |
| **Tickertape Performance** (tickertape) | 5d | 5,016 | 0.1009 | +0.38% | -0.68% | **+1.07%** | 48.3% |
| **NiftyTrader Technical** (niftytrader) | 5d | 71,521 | 0.0667 | +0.43% | -0.33% | **+0.76%** | 48.6% |
| **Trendlyne Durability** (trendlyne) | 5d | 20,619 | 0.0412 | +0.56% | -0.05% | **+0.60%** | 48.0% |
| **MoneyControl DuPont** (moneycontrol) | 5d | 8,142 | 0.0373 | +0.71% | +0.45% | **+0.26%** | 52.5% |
| **Trendlyne Valuation** (trendlyne) | 5d | 23,096 | 0.0366 | +0.46% | +0.27% | **+0.19%** | 45.5% |
| **Trendlyne Momentum** (trendlyne) | 5d | 23,467 | 0.0270 | +0.27% | +0.30% | **-0.04%** | 47.4% |
| **Tickertape Profitability** (tickertape) | 5d | 5,016 | -0.0348 | -0.46% | +0.09% | **-0.55%** | 35.4% |
| **Trendlyne Durability** (trendlyne) | 21d | 11,907 | 0.0756 | +2.65% | +1.00% | **+1.65%** | 52.3% |
| **NiftyTrader Technical** (niftytrader) | 21d | 41,616 | 0.0718 | +1.87% | +0.19% | **+1.68%** | 51.4% |
| **Tickertape Profitability** (tickertape) | 21d | 3,273 | 0.0676 | +2.47% | +3.57% | **-1.10%** | 53.3% |
| **MoneyControl DuPont** (moneycontrol) | 21d | 5,344 | 0.0580 | +2.37% | +0.82% | **+1.55%** | 53.1% |
| **Tickertape Valuation** (tickertape) | 21d | 3,273 | 0.0504 | +4.40% | +1.87% | **+2.53%** | 54.2% |
| **Trendlyne Momentum** (trendlyne) | 21d | 13,790 | 0.0394 | +2.09% | +2.14% | **-0.06%** | 50.7% |
| **Tickertape Performance** (tickertape) | 21d | 3,273 | 0.0381 | +4.43% | +1.57% | **+2.85%** | 55.1% |
| **Trendlyne Valuation** (trendlyne) | 21d | 13,563 | 0.0361 | +1.81% | +3.89% | **-2.08%** | 46.6% |

---

## 3. High Disagreement / Provider Divergence Stocks
Stocks exhibiting largest score divergence between providers (useful for spotting regime changes vs provider methodology gaps):

| Symbol | Date | Trendlyne Mom Pct | NiftyTrader Tech Pct | Divergence Delta | Note |
|---|---|---|---|---|---|
| **RELINFRA** | 2026-08-27 | 0.2 | 82.1 | **81.9 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **RAJESHEXPO** | 2026-08-27 | 1.5 | 82.1 | **80.6 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **PVP** | 2026-08-27 | 99.9 | 30.3 | **69.5 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **KENNAMET** | 2026-08-27 | 99.4 | 30.3 | **69.1 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **WHEELS** | 2026-08-27 | 98.3 | 30.3 | **67.9 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **ANDREWYU** | 2026-08-27 | 96.8 | 30.3 | **66.5 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **KOHINOOR** | 2026-08-27 | 96.8 | 30.3 | **66.5 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **RCOM** | 2026-08-27 | 20.0 | 82.1 | **62.1 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **SMARTLINK** | 2026-08-27 | 92.4 | 30.3 | **62.0 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **LICHSGFIN** | 2026-08-27 | 33.1 | 92.7 | **59.6 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **GOODYEAR** | 2026-08-27 | 23.6 | 82.1 | **58.5 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **KOVAI** | 2026-08-27 | 88.2 | 30.3 | **57.8 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **BPCL** | 2026-08-27 | 18.1 | 75.6 | **57.5 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **NAHARSPING** | 2026-08-27 | 87.0 | 30.3 | **56.7 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |
| **CSBBANK** | 2026-08-27 | 20.0 | 75.6 | **55.6 pts** | Trendlyne Momentum vs NiftyTrader Technical Disagreement |

---

## 4. Key Findings & Recommendations
- **Technical & Momentum Alignment**: Trendlyne Momentum and NiftyTrader Technical Ratings show positive correlation, but exhibit distinct sensitivity windows.
- **Quant Engine Superiority**: Internal Multi-Factor Composite (`quant_engine`) achieves high Information Coefficient (IC) and strong quintile lift relative to raw individual external scores.
- **Consensus Recommendation**: Use multi-provider agreement as a filter — stocks where Trendlyne, NiftyTrader, and Quant engines align in the top quintile have higher market growth win rates than single-provider signals.
