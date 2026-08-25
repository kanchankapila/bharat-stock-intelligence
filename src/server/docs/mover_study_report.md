# Mover Reverse-Engineering Study

Run: `2026-08-25T16:04:36`  |  events analyzed: **204,970** across 37 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |    20131 |
| calc_gap_up                 |    40205 |
| calc_intraday_breakout      |    11630 |
| calc_open_eq_high           |    64110 |
| calc_open_eq_low            |    41151 |
| calc_volume_shocker         |    21092 |
| et_screen_hammer            |        1 |
| et_screen_long_white_candle |        5 |
| mc_price_shockers           |       42 |
| mojo_gainers                |      232 |
| mojo_losers                 |      278 |
| nt_top_gainers              |       92 |
| nteod_gain5                 |       36 |
| nteod_gap_down              |       39 |
| nteod_gap_up                |       92 |
| nteod_gap_up_unfill         |        7 |
| nteod_high_delivery         |       12 |
| nteod_loss5                 |        5 |
| nteod_near_high_close       |       38 |
| nteod_near_low_close        |      103 |
| nteod_open_eq_high          |       55 |
| nteod_open_eq_low           |       69 |
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
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |    n |
|:-----------|:--------------|--------:|-----:|
| 2025-12-17 | f_mom_21d     |  0.1137 |  966 |
| 2025-12-17 | f_mom_5d      | -0.0236 |  973 |
| 2025-12-17 | f_rs_vs_nifty | -0.0961 |  975 |
| 2025-12-18 | f_rs_vs_nifty | -0.0067 |  964 |
| 2025-12-18 | f_mom_5d      | -0.0585 |  964 |
| 2025-12-18 | f_mom_21d     | -0.1093 |  957 |
| 2025-12-19 | f_rs_vs_nifty |  0.0773 | 1105 |
| 2025-12-19 | f_mom_5d      | -0.0119 | 1103 |
| 2025-12-19 | f_mom_21d     | -0.0784 | 1099 |
| 2025-12-22 | f_mom_21d     |  0.02   |  975 |
| 2025-12-22 | f_mom_5d      |  0.0055 |  984 |
| 2025-12-22 | f_rs_vs_nifty | -0.0366 |  986 |
| 2025-12-23 | f_mom_21d     |  0.0256 |  889 |
| 2025-12-23 | f_mom_5d      | -0      |  892 |
| 2025-12-23 | f_rs_vs_nifty | -0.023  |  894 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2025-12-17 | calc_intraday_breakout | f_mom_5d      | 13     |  0.0467 |  0.0036 |          33 |
| 2025-12-17 | calc_volume_shocker    | f_mom_5d      |  2.733 |  0.0736 |  0.0269 |          79 |
| 2025-12-17 | calc_volume_shocker    | f_mom_21d     |  2     |  0.065  |  0.0325 |          79 |
| 2025-12-17 | calc_open_eq_high      | f_mom_5d      |  1.283 |  0.2765 |  0.2154 |         562 |
| 2025-12-17 | calc_open_eq_low       | f_mom_21d     |  1.28  |  0.0578 |  0.0451 |         102 |
| 2025-12-17 | calc_gap_up            | f_mom_21d     |  1.146 |  0.0848 |  0.074  |         144 |
| 2025-12-17 | calc_gap_up            | f_mom_5d      |  0.943 |  0.0898 |  0.0952 |         144 |
| 2025-12-17 | calc_open_eq_high      | f_rs_vs_nifty |  0.886 |  0.2366 |  0.267  |         562 |
| 2025-12-17 | calc_gap_down          | f_mom_5d      |  0.87  |  0.0359 |  0.0413 |          55 |
| 2025-12-17 | calc_gap_down          | f_mom_21d     |  0.81  |  0.0307 |  0.0379 |          55 |
| 2025-12-17 | calc_intraday_breakout | f_rs_vs_nifty |  0.8   |  0.0143 |  0.0179 |          33 |
| 2025-12-17 | calc_open_eq_high      | f_mom_21d     |  0.795 |  0.2166 |  0.2726 |         562 |
| 2025-12-17 | calc_open_eq_low       | f_mom_5d      |  0.679 |  0.0341 |  0.0503 |         102 |
| 2025-12-17 | calc_open_eq_low       | f_rs_vs_nifty |  0.513 |  0.0358 |  0.0699 |         102 |
| 2025-12-17 | calc_volume_shocker    | f_rs_vs_nifty |  0.333 |  0.0197 |  0.0591 |          79 |

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