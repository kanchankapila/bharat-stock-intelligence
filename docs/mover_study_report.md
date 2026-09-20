# Mover Reverse-Engineering Study

Run: `2026-09-19T14:05:13`  |  events analyzed: **359,346** across 83 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |    20734 |
| calc_gap_up                 |    41378 |
| calc_intraday_breakout      |    11751 |
| calc_open_eq_high           |    65643 |
| calc_open_eq_low            |    41480 |
| calc_volume_shocker         |    21654 |
| et_gainers_1d               |        1 |
| et_screen_hammer            |        8 |
| et_screen_inverted_hammer   |        6 |
| et_screen_long_black_candle |       18 |
| et_screen_long_white_candle |       52 |
| mc_price_shockers           |      717 |
| mojo_gainers                |     3359 |
| mojo_losers                 |     4256 |
| nt_top_gainers              |     1488 |
| nteod_gain5                 |      334 |
| nteod_gap_down              |      884 |
| nteod_gap_up                |      929 |
| nteod_gap_up_unfill         |       90 |
| nteod_high_delivery         |      143 |
| nteod_loss5                 |      212 |
| nteod_near_high_close       |      610 |
| nteod_near_low_close        |     1229 |
| nteod_open_eq_high          |     1182 |
| nteod_open_eq_low           |      779 |
| nteod_universe              |     7206 |
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
| ntlive_eod_gain5            |      299 |
| ntlive_eod_gap_down         |     4738 |
| ntlive_eod_gap_up           |     6645 |
| ntlive_eod_loss5            |      210 |
| ntlive_eod_market           |    13080 |
| ntlive_eod_near_high        |     1531 |
| ntlive_eod_near_low         |     2795 |
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |   n |
|:-----------|:--------------|--------:|----:|
| 2026-01-09 | f_mom_21d     |  0.1217 | 993 |
| 2026-01-09 | f_mom_5d      |  0.0351 | 998 |
| 2026-01-09 | f_rs_vs_nifty | -0.0304 | 999 |
| 2026-01-12 | f_rs_vs_nifty |  0.0465 | 791 |
| 2026-01-12 | f_mom_5d      | -0.0493 | 790 |
| 2026-01-12 | f_mom_21d     | -0.0776 | 789 |
| 2026-01-13 | f_mom_21d     |  0.0679 | 938 |
| 2026-01-13 | f_mom_5d      | -0.0516 | 942 |
| 2026-01-13 | f_rs_vs_nifty | -0.0844 | 944 |
| 2026-01-14 | f_rs_vs_nifty |  0.0438 | 913 |
| 2026-01-14 | f_mom_21d     | -0.0341 | 910 |
| 2026-01-14 | f_mom_5d      | -0.0376 | 913 |
| 2026-01-16 | f_mom_5d      |  0.0677 | 986 |
| 2026-01-16 | f_mom_21d     |  0.0494 | 986 |
| 2026-01-16 | f_rs_vs_nifty |  0.0356 | 987 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2026-01-09 | calc_intraday_breakout | f_mom_5d      | 12     |  0.0215 |  0.0018 |          16 |
| 2026-01-09 | calc_open_eq_low       | f_mom_5d      |  2.333 |  0.0626 |  0.0268 |          83 |
| 2026-01-09 | calc_intraday_breakout | f_rs_vs_nifty |  2     |  0.0143 |  0.0071 |          16 |
| 2026-01-09 | calc_gap_down          | f_mom_5d      |  1.955 |  0.0769 |  0.0394 |         116 |
| 2026-01-09 | calc_volume_shocker    | f_mom_5d      |  1.391 |  0.0572 |  0.0411 |          87 |
| 2026-01-09 | calc_volume_shocker    | f_mom_21d     |  1.2   |  0.0539 |  0.0449 |          87 |
| 2026-01-09 | calc_gap_down          | f_mom_21d     |  1.156 |  0.0664 |  0.0575 |         116 |
| 2026-01-09 | calc_gap_up            | f_mom_5d      |  1.032 |  0.0572 |  0.0555 |         133 |
| 2026-01-09 | calc_gap_up            | f_mom_21d     |  1     |  0.0646 |  0.0646 |         133 |
| 2026-01-09 | calc_open_eq_low       | f_mom_21d     |  1     |  0.0431 |  0.0431 |          83 |
| 2026-01-09 | calc_open_eq_high      | f_mom_5d      |  0.977 |  0.2272 |  0.2326 |         564 |
| 2026-01-09 | calc_volume_shocker    | f_rs_vs_nifty |  0.96  |  0.0429 |  0.0446 |          87 |
| 2026-01-09 | calc_open_eq_high      | f_rs_vs_nifty |  0.842 |  0.2286 |  0.2714 |         564 |
| 2026-01-09 | calc_open_eq_low       | f_rs_vs_nifty |  0.828 |  0.0429 |  0.0518 |          83 |
| 2026-01-09 | calc_open_eq_high      | f_mom_21d     |  0.76  |  0.1993 |  0.2621 |         564 |

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