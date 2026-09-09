# Mover Reverse-Engineering Study

Run: `2026-09-06T10:30:25`  |  events analyzed: **334,966** across 83 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |    20467 |
| calc_gap_up                 |    40846 |
| calc_intraday_breakout      |    11860 |
| calc_open_eq_high           |    65416 |
| calc_open_eq_low            |    41554 |
| calc_volume_shocker         |    21486 |
| et_gainers_1d               |        1 |
| et_screen_hammer            |        8 |
| et_screen_inverted_hammer   |        5 |
| et_screen_long_black_candle |       16 |
| et_screen_long_white_candle |       52 |
| mc_price_shockers           |      379 |
| mojo_gainers                |     1796 |
| mojo_losers                 |     2246 |
| nt_top_gainers              |      812 |
| nteod_gain5                 |      243 |
| nteod_gap_down              |      363 |
| nteod_gap_up                |      710 |
| nteod_gap_up_unfill         |       64 |
| nteod_high_delivery         |      104 |
| nteod_loss5                 |       62 |
| nteod_near_high_close       |      416 |
| nteod_near_low_close        |      671 |
| nteod_open_eq_high          |      760 |
| nteod_open_eq_low           |      524 |
| nteod_universe              |     2052 |
| ntlive_0930_gain5           |       34 |
| ntlive_0930_gap_down        |     2621 |
| ntlive_0930_gap_up          |     4402 |
| ntlive_0930_loss5           |       10 |
| ntlive_0930_market          |     8039 |
| ntlive_0930_near_high       |     2706 |
| ntlive_0930_near_low        |     4182 |
| ntlive_1030_gain5           |       74 |
| ntlive_1030_gap_down        |     2618 |
| ntlive_1030_gap_up          |     4405 |
| ntlive_1030_loss5           |       22 |
| ntlive_1030_market          |     8039 |
| ntlive_1030_near_high       |     2035 |
| ntlive_1030_near_low        |     3061 |
| ntlive_1130_gain5           |       90 |
| ntlive_1130_gap_down        |     2118 |
| ntlive_1130_gap_up          |     4062 |
| ntlive_1130_loss5           |       22 |
| ntlive_1130_market          |     7034 |
| ntlive_1130_near_high       |     1387 |
| ntlive_1130_near_low        |     2656 |
| ntlive_1230_gain5           |      125 |
| ntlive_1230_gap_down        |     2618 |
| ntlive_1230_gap_up          |     4405 |
| ntlive_1230_loss5           |       35 |
| ntlive_1230_market          |     8039 |
| ntlive_1230_near_high       |     1284 |
| ntlive_1230_near_low        |     2967 |
| ntlive_1330_gain5           |      147 |
| ntlive_1330_gap_down        |     2618 |
| ntlive_1330_gap_up          |     4405 |
| ntlive_1330_loss5           |       39 |
| ntlive_1330_market          |     8039 |
| ntlive_1330_near_high       |     1252 |
| ntlive_1330_near_low        |     2770 |
| ntlive_1509_gain5           |       18 |
| ntlive_1509_gap_down        |      346 |
| ntlive_1509_gap_up          |      484 |
| ntlive_1509_loss5           |        5 |
| ntlive_1509_market          |     1005 |
| ntlive_1509_near_high       |      202 |
| ntlive_1509_near_low        |      216 |
| ntlive_1512_gain5           |       19 |
| ntlive_1512_gap_down        |      346 |
| ntlive_1512_gap_up          |      484 |
| ntlive_1512_loss5           |        5 |
| ntlive_1512_market          |     1005 |
| ntlive_1512_near_high       |      221 |
| ntlive_1512_near_low        |      184 |
| ntlive_eod_gain5            |      182 |
| ntlive_eod_gap_down         |     2673 |
| ntlive_eod_gap_up           |     4326 |
| ntlive_eod_loss5            |       68 |
| ntlive_eod_market           |     8038 |
| ntlive_eod_near_high        |      921 |
| ntlive_eod_near_low         |     1940 |
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |    n |
|:-----------|:--------------|--------:|-----:|
| 2025-12-29 | f_mom_21d     |  0.0295 |  967 |
| 2025-12-29 | f_mom_5d      | -0.0137 |  970 |
| 2025-12-29 | f_rs_vs_nifty | -0.0219 |  970 |
| 2025-12-30 | f_rs_vs_nifty |  0.1334 | 1079 |
| 2025-12-30 | f_mom_21d     |  0.0381 | 1075 |
| 2025-12-30 | f_mom_5d      |  0.0305 | 1078 |
| 2025-12-31 | f_rs_vs_nifty |  0.0406 | 1009 |
| 2025-12-31 | f_mom_21d     |  0.0107 | 1003 |
| 2025-12-31 | f_mom_5d      |  0.0067 | 1009 |
| 2026-01-01 | f_mom_21d     |  0.0377 | 1010 |
| 2026-01-01 | f_mom_5d      |  0.0368 | 1012 |
| 2026-01-01 | f_rs_vs_nifty |  0.0027 | 1012 |
| 2026-01-02 | f_mom_5d      |  0.1636 | 1018 |
| 2026-01-02 | f_mom_21d     |  0.1327 | 1014 |
| 2026-01-02 | f_rs_vs_nifty |  0.063  | 1018 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2025-12-29 | calc_intraday_breakout | f_mom_5d      | 36     |  0.0644 |  0.0018 |          52 |
| 2025-12-29 | calc_intraday_breakout | f_mom_21d     | 19.5   |  0.0703 |  0.0036 |          52 |
| 2025-12-29 | calc_volume_shocker    | f_mom_5d      |  2.267 |  0.1216 |  0.0537 |         151 |
| 2025-12-29 | calc_volume_shocker    | f_mom_21d     |  1.595 |  0.1063 |  0.0667 |         151 |
| 2025-12-29 | calc_volume_shocker    | f_rs_vs_nifty |  1.581 |  0.0877 |  0.0555 |         151 |
| 2025-12-29 | calc_gap_down          | f_mom_21d     |  1.4   |  0.0378 |  0.027  |          50 |
| 2025-12-29 | calc_intraday_breakout | f_rs_vs_nifty |  1.231 |  0.0286 |  0.0233 |          52 |
| 2025-12-29 | calc_open_eq_low       | f_mom_21d     |  1.222 |  0.0793 |  0.0649 |         172 |
| 2025-12-29 | calc_open_eq_high      | f_mom_5d      |  1.222 |  0.2165 |  0.1771 |         418 |
| 2025-12-29 | calc_gap_up            | f_mom_5d      |  1.071 |  0.0805 |  0.0751 |         127 |
| 2025-12-29 | calc_open_eq_low       | f_mom_5d      |  1.062 |  0.0608 |  0.0572 |         172 |
| 2025-12-29 | calc_gap_down          | f_mom_5d      |  1     |  0.0304 |  0.0304 |          50 |
| 2025-12-29 | calc_open_eq_high      | f_mom_21d     |  1     |  0.1802 |  0.1802 |         418 |
| 2025-12-29 | calc_gap_up            | f_mom_21d     |  0.9   |  0.0649 |  0.0721 |         127 |
| 2025-12-29 | calc_open_eq_low       | f_rs_vs_nifty |  0.731 |  0.068  |  0.093  |         172 |

## Engine hit-rate (movers found in engine top-N on T-1)

| engine         | event_date   | asof                             |   top_n |   hit_rate_pct |   n_movers |
|:---------------|:-------------|:---------------------------------|--------:|---------------:|-----------:|
| technical_rank | 2026-07-07   | 2026-07-06 00:00:00+00:00        |      20 |           0.52 |        962 |
| technical_rank | 2026-07-08   | 2026-07-07 00:00:00+00:00        |      20 |           0.41 |        723 |
| technical_rank | 2026-07-09   | 2026-07-08 00:00:00+00:00        |      20 |           0.77 |       1043 |
| technical_rank | 2026-07-15   | 2026-07-14 00:00:00+00:00        |      20 |           1.09 |        823 |
| technical_rank | 2026-07-20   | 2026-07-17 00:00:00+00:00        |      20 |           0.68 |        878 |
| technical_rank | 2026-07-21   | 2026-07-20 00:00:00+00:00        |      20 |           1.03 |        878 |
| technical_rank | 2026-07-22   | 2026-07-21 00:00:00+00:00        |      20 |           0.61 |        976 |
| technical_rank | 2026-07-23   | 2026-07-22 10:00:18.296201+00:00 |      20 |           0.74 |        816 |
| technical_rank | 2026-07-24   | 2026-07-23 00:00:00+00:00        |      20 |           0.76 |        789 |
| technical_rank | 2026-07-27   | 2026-07-24 00:00:00+00:00        |      20 |           1.24 |        970 |
| technical_rank | 2026-07-28   | 2026-07-27 00:00:00+00:00        |      20 |           0.55 |        910 |
| technical_rank | 2026-08-04   | 2026-08-03 00:00:00+00:00        |      20 |           1.43 |        977 |
| technical_rank | 2026-08-05   | 2026-08-04 00:00:00+00:00        |      20 |           1.11 |        993 |
| technical_rank | 2026-08-06   | 2026-08-05 00:00:00+00:00        |      20 |           1.24 |        969 |
| technical_rank | 2026-08-07   | 2026-08-06 00:00:00+00:00        |      20 |           1.58 |        948 |

### How to read this
- IC > ~0.05 with decent n = factor carries real information about which movers pay.
- Lift > 1.5 on a class = conditioning signal worth adding to that detector's ranker.
- Hit-rate near 0% = the engine never saw the mover coming; that gap, not the math, is the first thing to fix.