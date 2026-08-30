# Mover Reverse-Engineering Study

Run: `2026-08-30T12:19:07`  |  events analyzed: **251,675** across 82 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |    20287 |
| calc_gap_up                 |    40432 |
| calc_intraday_breakout      |    11762 |
| calc_open_eq_high           |    64724 |
| calc_open_eq_low            |    41245 |
| calc_volume_shocker         |    21291 |
| et_gainers_1d               |        1 |
| et_screen_hammer            |        1 |
| et_screen_inverted_hammer   |        1 |
| et_screen_long_black_candle |        2 |
| et_screen_long_white_candle |       17 |
| mc_price_shockers           |      125 |
| mojo_gainers                |      603 |
| mojo_losers                 |      788 |
| nt_top_gainers              |      260 |
| nteod_gain5                 |       87 |
| nteod_gap_down              |       89 |
| nteod_gap_up                |      297 |
| nteod_gap_up_unfill         |       22 |
| nteod_high_delivery         |       24 |
| nteod_loss5                 |       19 |
| nteod_near_high_close       |       92 |
| nteod_near_low_close        |      338 |
| nteod_open_eq_high          |      184 |
| nteod_open_eq_low           |      202 |
| ntlive_0930_gain5           |       13 |
| ntlive_0930_gap_down        |      709 |
| ntlive_0930_gap_up          |     1902 |
| ntlive_0930_loss5           |        1 |
| ntlive_0930_market          |     3016 |
| ntlive_0930_near_high       |     1193 |
| ntlive_0930_near_low        |     1671 |
| ntlive_1030_gain5           |       29 |
| ntlive_1030_gap_down        |      708 |
| ntlive_1030_gap_up          |     1903 |
| ntlive_1030_loss5           |        4 |
| ntlive_1030_market          |     3016 |
| ntlive_1030_near_high       |      698 |
| ntlive_1030_near_low        |     1408 |
| ntlive_1130_gain5           |       36 |
| ntlive_1130_gap_down        |      708 |
| ntlive_1130_gap_up          |     1903 |
| ntlive_1130_loss5           |        4 |
| ntlive_1130_market          |     3016 |
| ntlive_1130_near_high       |      498 |
| ntlive_1130_near_low        |     1376 |
| ntlive_1230_gain5           |       47 |
| ntlive_1230_gap_down        |      708 |
| ntlive_1230_gap_up          |     1903 |
| ntlive_1230_loss5           |        6 |
| ntlive_1230_market          |     3016 |
| ntlive_1230_near_high       |      455 |
| ntlive_1230_near_low        |     1304 |
| ntlive_1330_gain5           |       55 |
| ntlive_1330_gap_down        |      708 |
| ntlive_1330_gap_up          |     1903 |
| ntlive_1330_loss5           |        7 |
| ntlive_1330_market          |     3016 |
| ntlive_1330_near_high       |      417 |
| ntlive_1330_near_low        |     1276 |
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
| ntlive_eod_gain5            |       47 |
| ntlive_eod_gap_down         |      525 |
| ntlive_eod_gap_up           |     1179 |
| ntlive_eod_loss5            |       10 |
| ntlive_eod_market           |     2011 |
| ntlive_eod_near_high        |      206 |
| ntlive_eod_near_low         |      626 |
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |   n |
|:-----------|:--------------|--------:|----:|
| 2025-12-22 | f_mom_21d     |  0.02   | 975 |
| 2025-12-22 | f_mom_5d      |  0.0055 | 984 |
| 2025-12-22 | f_rs_vs_nifty | -0.0366 | 986 |
| 2025-12-23 | f_mom_21d     |  0.0256 | 889 |
| 2025-12-23 | f_mom_5d      | -0      | 892 |
| 2025-12-23 | f_rs_vs_nifty | -0.023  | 894 |
| 2025-12-24 | f_mom_21d     |  0.0605 | 951 |
| 2025-12-24 | f_mom_5d      |  0.0602 | 952 |
| 2025-12-24 | f_rs_vs_nifty | -0.0182 | 954 |
| 2025-12-26 | f_mom_5d      |  0.0601 | 845 |
| 2025-12-26 | f_mom_21d     |  0.0464 | 844 |
| 2025-12-26 | f_rs_vs_nifty |  0.023  | 846 |
| 2025-12-29 | f_mom_21d     |  0.0295 | 967 |
| 2025-12-29 | f_mom_5d      | -0.0137 | 970 |
| 2025-12-29 | f_rs_vs_nifty | -0.0219 | 970 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2025-12-22 | calc_intraday_breakout | f_mom_21d     | 45     |  0.0811 |  0.0018 |          76 |
| 2025-12-22 | calc_intraday_breakout | f_mom_5d      | 11.25  |  0.0806 |  0.0072 |          76 |
| 2025-12-22 | calc_volume_shocker    | f_mom_5d      |  2.045 |  0.0806 |  0.0394 |         110 |
| 2025-12-22 | calc_volume_shocker    | f_mom_21d     |  1.957 |  0.0811 |  0.0414 |         110 |
| 2025-12-22 | calc_intraday_breakout | f_rs_vs_nifty |  1.846 |  0.0429 |  0.0233 |          76 |
| 2025-12-22 | calc_gap_down          | f_mom_5d      |  1.333 |  0.0287 |  0.0215 |          43 |
| 2025-12-22 | calc_gap_down          | f_mom_21d     |  1.25  |  0.027  |  0.0216 |          43 |
| 2025-12-22 | calc_open_eq_high      | f_mom_21d     |  1.132 |  0.1856 |  0.164  |         378 |
| 2025-12-22 | calc_gap_up            | f_mom_5d      |  0.887 |  0.0842 |  0.095  |         154 |
| 2025-12-22 | calc_open_eq_high      | f_mom_5d      |  0.87  |  0.1559 |  0.1792 |         378 |
| 2025-12-22 | calc_open_eq_high      | f_rs_vs_nifty |  0.824 |  0.1592 |  0.1932 |         378 |
| 2025-12-22 | calc_gap_up            | f_mom_21d     |  0.759 |  0.0739 |  0.0973 |         154 |
| 2025-12-22 | calc_open_eq_low       | f_mom_21d     |  0.677 |  0.0757 |  0.1117 |         225 |
| 2025-12-22 | calc_open_eq_low       | f_rs_vs_nifty |  0.53  |  0.0626 |  0.1181 |         225 |
| 2025-12-22 | calc_open_eq_low       | f_mom_5d      |  0.342 |  0.0466 |  0.1362 |         225 |

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