# Mover Reverse-Engineering Study

Run: `2026-09-15T19:41:20`  |  events analyzed: **218,948** across 83 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |     5962 |
| calc_gap_up                 |    12754 |
| calc_intraday_breakout      |     4688 |
| calc_open_eq_high           |    25986 |
| calc_open_eq_low            |    15642 |
| calc_volume_shocker         |     9994 |
| et_gainers_1d               |        1 |
| et_screen_hammer            |        8 |
| et_screen_inverted_hammer   |        6 |
| et_screen_long_black_candle |       18 |
| et_screen_long_white_candle |       52 |
| mc_price_shockers           |      589 |
| mojo_gainers                |     2512 |
| mojo_losers                 |     3785 |
| nt_top_gainers              |     1238 |
| nteod_gain5                 |      283 |
| nteod_gap_down              |      735 |
| nteod_gap_up                |      750 |
| nteod_gap_up_unfill         |       68 |
| nteod_high_delivery         |      124 |
| nteod_loss5                 |       76 |
| nteod_near_high_close       |      508 |
| nteod_near_low_close        |      787 |
| nteod_open_eq_high          |      962 |
| nteod_open_eq_low           |      595 |
| nteod_universe              |     4112 |
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
| ntlive_eod_gain5            |      205 |
| ntlive_eod_gap_down         |     3696 |
| ntlive_eod_gap_up           |     5090 |
| ntlive_eod_loss5            |      195 |
| ntlive_eod_market           |    10051 |
| ntlive_eod_near_high        |     1107 |
| ntlive_eod_near_low         |     2464 |
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |    n |
|:-----------|:--------------|--------:|-----:|
| 2026-06-16 | f_rs_vs_nifty |  0.1657 | 1421 |
| 2026-06-16 | f_mom_21d     |  0.0928 | 1421 |
| 2026-06-16 | f_mom_5d      |  0.0652 | 1421 |
| 2026-06-16 | f_news_sent   |  0.0135 |   53 |
| 2026-06-16 | f_news_count  | -0.1891 |   53 |
| 2026-06-17 | f_mom_5d      |  0.1365 | 1070 |
| 2026-06-17 | f_mom_21d     |  0.1251 | 1070 |
| 2026-06-17 | f_rs_vs_nifty |  0.0907 | 1070 |
| 2026-06-17 | f_news_sent   | -0.0429 |   40 |
| 2026-06-17 | f_news_count  | -0.1875 |   40 |
| 2026-06-18 | f_mom_21d     |  0.2474 | 1161 |
| 2026-06-18 | f_news_sent   |  0.2382 |   61 |
| 2026-06-18 | f_mom_5d      |  0.1761 | 1161 |
| 2026-06-18 | f_rs_vs_nifty |  0.0865 | 1161 |
| 2026-06-18 | f_news_count  | -0.3339 |   61 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2026-06-16 | calc_intraday_breakout | f_mom_5d      |  9.667 |  0.0962 |  0.01   |         114 |
| 2026-06-16 | calc_intraday_breakout | f_mom_21d     |  7.429 |  0.0864 |  0.0116 |         114 |
| 2026-06-16 | calc_intraday_breakout | f_news_sent   |  3.522 |  0.1304 |  0.037  |         114 |
| 2026-06-16 | calc_gap_up            | f_rsi         |  3     |  0.5    |  0.1667 |         325 |
| 2026-06-16 | calc_intraday_breakout | f_rs_vs_nifty |  2.053 |  0.0677 |  0.0329 |         114 |
| 2026-06-16 | calc_gap_up            | f_adx         |  2     |  0.3333 |  0.1667 |         325 |
| 2026-06-16 | calc_gap_down          | f_news_count  |  1.744 |  0.0513 |  0.0294 |         190 |
| 2026-06-16 | calc_gap_down          | f_mom_21d     |  1.703 |  0.1047 |  0.0615 |         190 |
| 2026-06-16 | calc_volume_shocker    | f_mom_5d      |  1.312 |  0.1045 |  0.0796 |         189 |
| 2026-06-16 | calc_open_eq_low       | f_rs_vs_nifty |  1.309 |  0.1337 |  0.1021 |         264 |
| 2026-06-16 | calc_gap_down          | f_mom_5d      |  1.25  |  0.0995 |  0.0796 |         190 |
| 2026-06-16 | calc_open_eq_high      | f_news_sent   |  1.174 |  0.1304 |  0.1111 |         342 |
| 2026-06-16 | calc_open_eq_high      | f_news_count  |  1.046 |  0.1538 |  0.1471 |         342 |
| 2026-06-16 | calc_gap_up            | f_mom_5d      |  0.97  |  0.1592 |  0.1642 |         325 |
| 2026-06-16 | calc_volume_shocker    | f_mom_21d     |  0.965 |  0.0914 |  0.0947 |         189 |

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