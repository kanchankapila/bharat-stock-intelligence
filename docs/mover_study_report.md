# Mover Reverse-Engineering Study

Run: `2026-10-06T07:45:54`  |  events analyzed: **46,983** across 13 classes

## Event counts by class

| source                 |   events |
|:-----------------------|---------:|
| calc_gap_down          |     1534 |
| calc_gap_up            |     2662 |
| calc_intraday_breakout |     2908 |
| calc_open_eq_high      |    12092 |
| calc_open_eq_low       |     7972 |
| calc_volume_shocker    |     5225 |
| mc_price_shockers      |      764 |
| mojo_gainers           |     4635 |
| mojo_losers            |     6192 |
| nt_top_gainers         |     2051 |
| nteod_gain5            |      505 |
| nteod_high_delivery    |      148 |
| nteod_loss5            |      295 |

## Factor rank-IC vs realized mover returns (per-date aggregate)

| factor              |   mean_ic |   median_ic |   positive_dates |   dates |   t_stat |   total_n |
|:--------------------|----------:|------------:|-----------------:|--------:|---------:|----------:|
| f_cost_of_carry     |    0.1873 |      0.1682 |               50 |      58 |     6.85 |      6601 |
| f_preopen_gap_pct   |    0.1483 |      0.1534 |               47 |      54 |     6.95 |     16362 |
| f_preopen_imbalance |    0.1032 |      0.1051 |               42 |      54 |     5.37 |     16256 |
| f_so_pcr            |    0.0555 |      0.0562 |               35 |      57 |     2.74 |      5825 |
| f_rsi               |    0.0539 |      0.0535 |               47 |      60 |     5.84 |     35374 |
| f_rs_vs_nifty       |    0.0439 |      0.0486 |               41 |      60 |     3.84 |     36838 |
| f_mom_21d           |    0.0439 |      0.0486 |               41 |      60 |     3.84 |     36838 |
| f_vol_ratio         |    0.0358 |      0.0306 |               42 |      60 |     4.82 |     35370 |
| f_mom_5d            |    0.0292 |      0.0391 |               40 |      60 |     2.73 |     36867 |
| f_adx               |    0.0203 |      0.0253 |               39 |      60 |     2.87 |     35374 |
| f_rollover_pct      |    0.0203 |      0.0123 |               33 |      60 |     1.29 |      6858 |
| f_news_sent         |    0.0063 |      0.0042 |               33 |      60 |     0.65 |     18620 |
| f_mf_holding_change |    0.0012 |     -0.0054 |               15 |      31 |     0.11 |     18021 |
| f_delivery_pct      |   -0.002  |     -0.0024 |               29 |      60 |    -0.18 |     35707 |
| f_earnings_yield    |   -0.0169 |     -0.0159 |               26 |      60 |    -1.57 |     30108 |
| f_news_count        |   -0.0223 |     -0.0259 |               23 |      60 |    -1.91 |     18620 |
| f_mf_holding_pct    |   -0.0317 |     -0.0399 |                9 |      31 |    -1.86 |     18266 |

## Cohort lift consistency across dates

| class                  | factor              |   median_lift |   mean_lift |   lift_gt_1_dates |   dates |   avg_members |
|:-----------------------|:--------------------|--------------:|------------:|------------------:|--------:|--------------:|
| calc_volume_shocker    | f_vol_ratio         |         5.115 |       5.476 |                60 |      60 |          87.1 |
| calc_volume_shocker    | f_mom_5d            |         3.572 |       3.776 |                60 |      60 |          87.1 |
| calc_intraday_breakout | f_vol_ratio         |         3.944 |       5.014 |                56 |      56 |          50.7 |
| calc_intraday_breakout | f_mom_5d            |        20     |      23.346 |                42 |      42 |          52.5 |
| calc_intraday_breakout | f_rsi               |        24     |      28.115 |                35 |      35 |          51.3 |
| calc_intraday_breakout | f_mom_21d           |        21.333 |      23.967 |                35 |      35 |          50.7 |
| calc_intraday_breakout | f_rs_vs_nifty       |        21.333 |      23.966 |                35 |      35 |          50.7 |
| calc_open_eq_high      | f_mf_holding_pct    |         2.031 |       2.141 |                32 |      32 |         209.7 |
| mojo_gainers           | f_news_count        |         3.776 |       3.883 |                26 |      26 |         178.3 |
| mojo_losers            | f_news_count        |         3.666 |       3.799 |                26 |      26 |         238.2 |
| mojo_losers            | f_mf_holding_change |         1.399 |       1.379 |                26 |      26 |         238.2 |
| nt_top_gainers         | f_mf_holding_pct    |         2.317 |       2.612 |                25 |      25 |          82   |
| mojo_losers            | f_news_sent         |         1.76  |       1.833 |                24 |      24 |         231.2 |
| mojo_gainers           | f_news_sent         |         1.602 |       1.675 |                24 |      24 |         184.2 |
| mc_price_shockers      | f_mom_5d            |         4.8   |       6.206 |                22 |      22 |          34.7 |
| mc_price_shockers      | f_mom_21d           |        17.25  |      23.675 |                20 |      20 |          34.8 |
| mc_price_shockers      | f_rs_vs_nifty       |        17.236 |      23.674 |                20 |      20 |          34.8 |
| mc_price_shockers      | f_rsi               |        29     |      26.724 |                18 |      18 |          34.7 |
| mc_price_shockers      | f_adx               |         7.992 |       9.673 |                16 |      16 |          34.8 |
| nteod_loss5            | f_news_count        |         1.991 |       2.032 |                 7 |       7 |          33.4 |
| nteod_loss5            | f_vol_ratio         |         4.514 |       5.281 |                 6 |       6 |          36.5 |
| nteod_loss5            | f_rsi               |         3.042 |       3.089 |                 6 |       6 |          36.5 |
| nteod_high_delivery    | f_vol_ratio         |         6.86  |       6.86  |                 2 |       2 |          20.5 |
| nteod_high_delivery    | f_news_count        |         4.133 |       4.133 |                 2 |       2 |          20.5 |
| nteod_high_delivery    | f_mf_holding_change |         2.412 |       2.412 |                 2 |       2 |          20.5 |
| nteod_high_delivery    | f_mf_holding_pct    |         6.258 |       6.258 |                 1 |       1 |          10   |
| nteod_high_delivery    | f_news_sent         |         3.989 |       3.989 |                 1 |       1 |          31   |
| nteod_high_delivery    | f_rollover_pct      |         2.75  |       2.75  |                 1 |       1 |          31   |
| nteod_high_delivery    | f_preopen_imbalance |         1.125 |       1.125 |                 1 |       1 |          31   |
| calc_volume_shocker    | f_mom_21d           |         3     |       3.268 |                59 |      60 |          87.1 |

## Engine top-N hit-rate summary

| engine          |   dates |   top_n |   hits_found |   movers |   mean_hit_rate_pct |   max_hit_rate_pct |
|:----------------|--------:|--------:|-------------:|---------:|--------------------:|-------------------:|
| confluence_rank |      60 |      20 |          625 |    36870 |                1.76 |               3.46 |
| intraday_rank   |      57 |      20 |          361 |    35405 |                1.04 |               2.25 |
| technical_rank  |      60 |      20 |          293 |    36870 |                0.88 |               2.74 |

## Canonical pre-open call accuracy — aggregate

|   dates |   movers |   matched |   opposite |   not_flagged |   matched_all_pct |   opposite_all_pct |   not_flagged_pct |   directional_precision_pct |
|--------:|---------:|----------:|-----------:|--------------:|------------------:|-------------------:|------------------:|----------------------------:|
|      36 |    25607 |      2774 |       2443 |         20390 |             10.83 |               9.54 |             79.63 |                       53.17 |

Historical recommendation snapshots were unavailable for **24** of 60 event dates; those dates are excluded from accuracy rather than being misreported as all Hold/not-flagged.

## Canonical pre-open call accuracy — by date

| event_date   |   matched |   opposite |   not_flagged |   n_movers |   snapshot_symbols | snapshot_asof                    |   matched_pct |   opposite_pct |   not_flagged_pct |
|:-------------|----------:|-----------:|--------------:|-----------:|-------------------:|:---------------------------------|--------------:|---------------:|------------------:|
| 2026-08-11   |        44 |         26 |           413 |        483 |               2200 | 2026-08-10T18:23:51.363893+00:00 |          9.11 |           5.38 |             85.51 |
| 2026-08-12   |        36 |         20 |           439 |        495 |               2202 | 2026-08-12T03:00:49.132879+00:00 |          7.27 |           4.04 |             88.69 |
| 2026-08-13   |        26 |         30 |           462 |        518 |               2205 | 2026-08-13T02:00:00.900914+00:00 |          5.02 |           5.79 |             89.19 |
| 2026-08-14   |        51 |         29 |           389 |        469 |               2205 | 2026-08-14T02:00:00.884303+00:00 |         10.87 |           6.18 |             82.94 |
| 2026-08-17   |        52 |         36 |           417 |        505 |               2225 | 2026-08-17T02:00:02.076469+00:00 |         10.3  |           7.13 |             82.57 |
| 2026-08-18   |        54 |         44 |           374 |        472 |               2229 | 2026-08-18T02:00:01.564459+00:00 |         11.44 |           9.32 |             79.24 |
| 2026-08-19   |        52 |         38 |           396 |        486 |               2236 | 2026-08-19T02:00:01.496408+00:00 |         10.7  |           7.82 |             81.48 |
| 2026-08-20   |        48 |         56 |           391 |        495 |               2239 | 2026-08-20T02:00:02.009136+00:00 |          9.7  |          11.31 |             78.99 |
| 2026-08-21   |        45 |         42 |           405 |        492 |               2216 | 2026-08-21T02:00:02.013600+00:00 |          9.15 |           8.54 |             82.32 |
| 2026-08-24   |        82 |         80 |           648 |        810 |               2215 | 2026-08-24T03:06:00.508207+00:00 |         10.12 |           9.88 |             80    |
| 2026-08-25   |        48 |         23 |           345 |        416 |               2156 | 2026-08-24T08:52:08.649785+00:00 |         11.54 |           5.53 |             82.93 |
| 2026-08-26   |        72 |         89 |           665 |        826 |               2156 | 2026-08-26T02:00:01.558531+00:00 |          8.72 |          10.77 |             80.51 |
| 2026-08-27   |       104 |         68 |           625 |        797 |               2151 | 2026-08-27T03:25:45.858764+00:00 |         13.05 |           8.53 |             78.42 |
| 2026-08-28   |        84 |         72 |           669 |        825 |               2132 | 2026-08-27T21:50:40.563016+00:00 |         10.18 |           8.73 |             81.09 |
| 2026-08-31   |       111 |         57 |           694 |        862 |               2150 | 2026-08-30T11:41:23.975472+00:00 |         12.88 |           6.61 |             80.51 |
| 2026-09-01   |       104 |        107 |           574 |        785 |               2130 | 2026-08-31T18:10:15.248153+00:00 |         13.25 |          13.63 |             73.12 |
| 2026-09-02   |       103 |         85 |           594 |        782 |               2111 | 2026-09-01T17:00:01.135758+00:00 |         13.17 |          10.87 |             75.96 |
| 2026-09-03   |        88 |        103 |           628 |        819 |               2099 | 2026-09-02T17:20:40.741635+00:00 |         10.74 |          12.58 |             76.68 |
| 2026-09-04   |        83 |        114 |           634 |        831 |               2084 | 2026-09-03T17:00:02.664803+00:00 |          9.99 |          13.72 |             76.29 |
| 2026-09-07   |       105 |         82 |           656 |        843 |               2080 | 2026-09-04T17:00:03.150316+00:00 |         12.46 |           9.73 |             77.82 |
| 2026-09-08   |        67 |         32 |           362 |        461 |               2068 | 2026-09-07T17:00:02.879848+00:00 |         14.53 |           6.94 |             78.52 |
| 2026-09-09   |        90 |         82 |           640 |        812 |               2054 | 2026-09-08T17:00:19.005897+00:00 |         11.08 |          10.1  |             78.82 |
| 2026-09-10   |        97 |         82 |           576 |        755 |               2062 | 2026-09-09T17:00:01.833884+00:00 |         12.85 |          10.86 |             76.29 |
| 2026-09-11   |        96 |         82 |           682 |        860 |               2040 | 2026-09-10T17:00:01.867380+00:00 |         11.16 |           9.53 |             79.3  |
| 2026-09-16   |        89 |         75 |           620 |        784 |               1997 | 2026-09-15T17:00:03.514035+00:00 |         11.35 |           9.57 |             79.08 |
| 2026-09-17   |        90 |         78 |           651 |        819 |               1987 | 2026-09-16T17:31:15.776894+00:00 |         10.99 |           9.52 |             79.49 |
| 2026-09-18   |       101 |         75 |           629 |        805 |               1928 | 2026-09-18T01:41:36.912483+00:00 |         12.55 |           9.32 |             78.14 |
| 2026-09-21   |        92 |         83 |           611 |        786 |               1973 | 2026-09-18T17:00:05.240202+00:00 |         11.7  |          10.56 |             77.74 |
| 2026-09-22   |        77 |         74 |           640 |        791 |               1973 | 2026-09-21T17:00:02.713370+00:00 |          9.73 |           9.36 |             80.91 |
| 2026-09-23   |        95 |         77 |           667 |        839 |               1981 | 2026-09-22T17:21:07.413881+00:00 |         11.32 |           9.18 |             79.5  |
| 2026-09-24   |        84 |         89 |           690 |        863 |               1990 | 2026-09-23T17:00:01.123757+00:00 |          9.73 |          10.31 |             79.95 |
| 2026-09-25   |        78 |         89 |           613 |        780 |               1970 | 2026-09-24T17:46:07.286994+00:00 |         10    |          11.41 |             78.59 |
| 2026-09-28   |        86 |         94 |           759 |        939 |               1975 | 2026-09-25T17:00:01.017708+00:00 |          9.16 |          10.01 |             80.83 |
| 2026-09-29   |        94 |         56 |           608 |        758 |               1956 | 2026-09-25T17:00:01.017708+00:00 |         12.4  |           7.39 |             80.21 |
| 2026-10-01   |        78 |         98 |           625 |        801 |               1972 | 2026-09-30T17:00:02.475451+00:00 |          9.74 |          12.23 |             78.03 |
| 2026-10-05   |        68 |         76 |           599 |        743 |               1895 | 2026-10-02T08:54:59.639792+00:00 |          9.15 |          10.23 |             80.62 |

Percentages are reported per date and include all three buckets: matched, opposite, and not flagged. Hold/missing calls are not flagged; only an actionable call in the wrong realized direction is opposite. Directional precision excludes Hold/missing but is shown beside total coverage so it cannot be presented as whole-universe accuracy.

### How to read this
- IC or lift is exploratory until it repeats across enough independent dates; never change a live weight from one date or a pooled row count.
- Hit-rate near 0% = the engine never saw the mover coming; that gap, not the math, is the first thing to fix.