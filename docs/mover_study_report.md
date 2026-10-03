# Mover Reverse-Engineering Study

Run: `2026-10-02T15:25:54`  |  events analyzed: **398,615** across 83 classes

## Event counts by class

| source                      |   events |
|:----------------------------|---------:|
| calc_gap_down               |    20525 |
| calc_gap_up                 |    41647 |
| calc_intraday_breakout      |    12061 |
| calc_open_eq_high           |    65900 |
| calc_open_eq_low            |    41604 |
| calc_volume_shocker         |    21955 |
| et_gainers_1d               |        1 |
| et_screen_hammer            |        8 |
| et_screen_inverted_hammer   |        6 |
| et_screen_long_black_candle |       19 |
| et_screen_long_white_candle |       58 |
| mc_price_shockers           |     1004 |
| mojo_gainers                |     4753 |
| mojo_losers                 |     6720 |
| nt_top_gainers              |     2222 |
| nteod_gain5                 |      554 |
| nteod_gap_down              |     1413 |
| nteod_gap_up                |     1332 |
| nteod_gap_up_unfill         |      141 |
| nteod_high_delivery         |      221 |
| nteod_loss5                 |      304 |
| nteod_near_high_close       |      906 |
| nteod_near_low_close        |     2113 |
| nteod_open_eq_high          |     1981 |
| nteod_open_eq_low           |     1324 |
| nteod_universe              |    16515 |
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
| ntlive_eod_gain5            |      484 |
| ntlive_eod_gap_down         |     8565 |
| ntlive_eod_gap_up           |    10708 |
| ntlive_eod_loss5            |      308 |
| ntlive_eod_market           |    22179 |
| ntlive_eod_near_high        |     2308 |
| ntlive_eod_near_low         |     4871 |
| ntlive_market               |     1005 |

## Factor rank-IC vs realized mover returns

| t1_date    | factor        |      ic |    n |
|:-----------|:--------------|--------:|-----:|
| 2026-01-23 | f_mom_21d     |  0.1453 |  983 |
| 2026-01-23 | f_rs_vs_nifty |  0.1153 |  987 |
| 2026-01-23 | f_mom_5d      |  0.1088 |  984 |
| 2026-01-27 | f_rs_vs_nifty |  0.081  | 1217 |
| 2026-01-27 | f_mom_5d      | -0.1347 | 1217 |
| 2026-01-27 | f_mom_21d     | -0.1619 | 1215 |
| 2026-01-28 | f_mom_21d     |  0.0793 |  963 |
| 2026-01-28 | f_mom_5d      |  0.0583 |  965 |
| 2026-01-28 | f_rs_vs_nifty |  0.0397 |  965 |
| 2026-01-29 | f_news_sent   |  0.0841 |   49 |
| 2026-01-29 | f_rs_vs_nifty |  0.0352 |  849 |
| 2026-01-29 | f_mom_5d      | -0.1011 |  849 |
| 2026-01-29 | f_mom_21d     | -0.1119 |  849 |
| 2026-01-29 | f_news_count  | -0.1494 |   49 |
| 2026-01-30 | f_mom_5d      | -0.0531 |  162 |

## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))

| t1_date    | class                  | factor        |   lift |   p_top |   p_bot |   n_members |
|:-----------|:-----------------------|:--------------|-------:|--------:|--------:|------------:|
| 2026-01-23 | calc_intraday_breakout | f_rs_vs_nifty |  5     |  0.0089 |  0.0018 |          16 |
| 2026-01-23 | calc_gap_up            | f_news_count  |  2.903 |  0.0968 |  0.0333 |         217 |
| 2026-01-23 | calc_open_eq_low       | f_mom_5d      |  2.271 |  0.0607 |  0.0267 |         118 |
| 2026-01-23 | calc_gap_down          | f_mom_5d      |  1.74  |  0.0589 |  0.0339 |         103 |
| 2026-01-23 | calc_gap_up            | f_mom_5d      |  1.428 |  0.1196 |  0.0838 |         217 |
| 2026-01-23 | calc_open_eq_low       | f_mom_21d     |  1.167 |  0.0501 |  0.0429 |         118 |
| 2026-01-23 | calc_volume_shocker    | f_mom_5d      |  1.163 |  0.0643 |  0.0553 |         103 |
| 2026-01-23 | calc_open_eq_high      | f_mom_5d      |  1.065 |  0.2107 |  0.1979 |         430 |
| 2026-01-23 | calc_gap_down          | f_mom_21d     |  1.037 |  0.0501 |  0.0483 |         103 |
| 2026-01-23 | calc_open_eq_low       | f_news_count  |  0.968 |  0.0323 |  0.0333 |         118 |
| 2026-01-23 | calc_gap_up            | f_mom_21d     |  0.966 |  0.102  |  0.1055 |         217 |
| 2026-01-23 | calc_open_eq_high      | f_mom_21d     |  0.89  |  0.1878 |  0.2111 |         430 |
| 2026-01-23 | calc_volume_shocker    | f_mom_21d     |  0.771 |  0.0483 |  0.0626 |         103 |
| 2026-01-23 | calc_open_eq_high      | f_rs_vs_nifty |  0.727 |  0.1711 |  0.2353 |         430 |
| 2026-01-23 | calc_volume_shocker    | f_rs_vs_nifty |  0.708 |  0.0303 |  0.0428 |         103 |

## Engine hit-rate (movers found in engine top-N on T-1)

| engine         | event_date   | asof                             |   top_n |   hit_rate_pct |   n_movers |
|:---------------|:-------------|:---------------------------------|--------:|---------------:|-----------:|
| technical_rank | 2026-07-07   | 2026-07-06 00:00:00+00:00        |      20 |           0.52 |        962 |
| technical_rank | 2026-07-08   | 2026-07-07 00:00:00+00:00        |      20 |           0.55 |        723 |
| technical_rank | 2026-07-09   | 2026-07-08 00:00:00+00:00        |      20 |           0.77 |       1043 |
| technical_rank | 2026-07-15   | 2026-07-14 00:00:00+00:00        |      20 |           1.09 |        823 |
| technical_rank | 2026-07-20   | 2026-07-17 00:00:00+00:00        |      20 |           0.68 |        878 |
| technical_rank | 2026-07-21   | 2026-07-20 00:00:00+00:00        |      20 |           1.03 |        878 |
| technical_rank | 2026-07-22   | 2026-07-21 00:00:00+00:00        |      20 |           0.51 |        976 |
| technical_rank | 2026-07-23   | 2026-07-22 10:00:18.296201+00:00 |      20 |           0.74 |        816 |
| technical_rank | 2026-07-24   | 2026-07-23 00:00:00+00:00        |      20 |           0.63 |        789 |
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