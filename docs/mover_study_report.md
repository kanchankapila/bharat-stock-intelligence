# Mover Reverse-Engineering Study

Run: `2026-10-24T14:04:45`  |  events analyzed: **72,749** across 13 classes

## Event counts by class

| source                 |   events |
|:-----------------------|---------:|
| calc_gap_down          |     5717 |
| calc_gap_up            |     7752 |
| calc_intraday_breakout |     5048 |
| calc_open_eq_high      |    19932 |
| calc_open_eq_low       |    12879 |
| calc_volume_shocker    |     7427 |
| mc_price_shockers      |      676 |
| mojo_gainers           |     3995 |
| mojo_losers            |     6153 |
| nt_top_gainers         |     2114 |
| nteod_gain5            |      499 |
| nteod_high_delivery    |      191 |
| nteod_loss5            |      366 |

## Factor rank-IC vs realized event-day returns (per-date, by population)

| outcome              | scope             | factor               |   mean_ic |   median_ic |   positive_dates |   dates |   t_stat |   total_n |
|:---------------------|:------------------|:---------------------|----------:|------------:|-----------------:|--------:|---------:|----------:|
| prior_close_to_close | mover_cohort      | f_cost_of_carry      |    0.216  |      0.2004 |               36 |      40 |     6.99 |      4927 |
| prior_close_to_close | eligible_universe | f_cost_of_carry      |    0.1616 |      0.1469 |               37 |      41 |     7.08 |      8488 |
| prior_close_to_close | mover_cohort      | f_so_pcr             |    0.0763 |      0.0691 |               29 |      42 |     3.25 |      4455 |
| open_to_close        | mover_cohort      | f_preopen_imbalance  |    0.0516 |      0.0455 |               39 |      57 |     3.83 |     15231 |
| prior_close_to_close | mover_cohort      | f_rsi                |    0.0452 |      0.0537 |               42 |      62 |     4    |     30286 |
| prior_close_to_close | eligible_universe | f_so_pcr             |    0.0419 |      0.0487 |               30 |      43 |     2.45 |      7439 |
| prior_close_to_close | mover_cohort      | f_rs_vs_nifty        |    0.0344 |      0.0369 |               80 |     128 |     3.11 |     58461 |
| prior_close_to_close | mover_cohort      | f_mom_21d            |    0.0344 |      0.0369 |               80 |     128 |     3.11 |     58461 |
| prior_close_to_close | mover_cohort      | f_vol_ratio          |    0.0271 |      0.0258 |               45 |      62 |     3.53 |     30286 |
| open_to_close        | eligible_universe | f_preopen_imbalance  |    0.0255 |      0.0155 |               37 |      58 |     2.7  |     32217 |
| prior_close_to_close | mover_cohort      | f_mom_5d             |    0.0253 |      0.0323 |               82 |     128 |     2.28 |     58527 |
| prior_close_to_close | mover_cohort      | f_adx                |    0.0183 |      0.0179 |               41 |      62 |     2.36 |     30286 |
| prior_close_to_close | mover_cohort      | f_rollover_pct       |    0.0139 |      0.0206 |               24 |      42 |     0.7  |      5184 |
| prior_close_to_close | eligible_universe | f_news_sent          |    0.0116 |      0.0084 |               43 |      81 |     1.27 |     35843 |
| prior_close_to_close | eligible_universe | f_rollover_pct       |    0.0097 |      0.0068 |               25 |      43 |     0.79 |      8924 |
| prior_close_to_close | mover_cohort      | f_news_sent          |    0.0092 |      0.0014 |               34 |      65 |     0.86 |     16302 |
| prior_close_to_close | eligible_universe | f_delivery_pct       |    0.0074 |     -0.0012 |               63 |     128 |     0.97 |    151527 |
| prior_close_to_close | eligible_universe | f_adx                |    0.0049 |      0.0019 |               35 |      68 |     0.62 |     74029 |
| prior_close_to_close | mover_cohort      | f_news_count         |    0.0047 |      0.0023 |               33 |      65 |     0.36 |     16302 |
| prior_close_to_close | eligible_universe | f_mf_holding_change  |    0.0038 |      0.007  |               22 |      35 |     0.58 |     26535 |
| prior_close_to_close | eligible_universe | f_mf_holding_pct     |    0.0017 |     -0.0066 |               17 |      35 |     0.13 |     27195 |
| prior_close_to_close | mover_cohort      | f_delivery_pct       |   -0.0025 |     -0.0033 |               63 |     128 |    -0.26 |     58494 |
| prior_close_to_close | eligible_universe | f_news_count         |   -0.0029 |     -0.0036 |               37 |      80 |    -0.31 |     35821 |
| prior_close_to_close | eligible_universe | f_rsi                |   -0.0044 |      0.0066 |               36 |      68 |    -0.46 |     74029 |
| prior_close_to_close | eligible_universe | f_vol_ratio          |   -0.0071 |      0.004  |               36 |      68 |    -0.95 |     74030 |
| prior_close_to_close | mover_cohort      | f_mf_holding_change  |   -0.0071 |     -0.0094 |               16 |      35 |    -0.65 |     13127 |
| prior_close_to_close | mover_cohort      | f_earnings_yield     |   -0.0105 |     -0.005  |               30 |      61 |    -0.9  |     25664 |
| prior_close_to_close | eligible_universe | f_earnings_yield     |   -0.0105 |     -0.013  |               25 |      61 |    -1.48 |     62332 |
| prior_close_to_close | eligible_universe | f_mom_21d            |   -0.0114 |      0.0011 |               65 |     128 |    -1.15 |    151436 |
| prior_close_to_close | eligible_universe | f_rs_vs_nifty        |   -0.0114 |      0.0011 |               65 |     128 |    -1.15 |    151436 |
| prior_close_to_close | eligible_universe | f_block_value_cr_30d |   -0.0142 |     -0.0505 |                1 |       3 |    -0.08 |        95 |
| prior_close_to_close | eligible_universe | f_mom_5d             |   -0.018  |     -0.0151 |               53 |     128 |    -1.97 |    151578 |
| prior_close_to_close | eligible_universe | f_block_net_qty_30d  |   -0.0316 |     -0.1943 |                1 |       3 |    -0.19 |        95 |
| prior_close_to_close | mover_cohort      | f_mf_holding_pct     |   -0.0383 |     -0.0387 |               11 |      35 |    -2.33 |     13337 |
| open_to_close        | eligible_universe | f_preopen_gap_pct    |   -0.1318 |     -0.1356 |                5 |      58 |    -9.64 |     32259 |
| open_to_close        | mover_cohort      | f_preopen_gap_pct    |   -0.1659 |     -0.182  |                7 |      57 |    -9.04 |     15273 |

## Cohort lift consistency across dates

| class                  | factor              |   median_lift |   mean_lift |   lift_gt_1_dates |   dates |   avg_members |
|:-----------------------|:--------------------|--------------:|------------:|------------------:|--------:|--------------:|
| calc_intraday_breakout | f_mom_5d            |        11.333 |      13.857 |                61 |      61 |          62.8 |
| mojo_losers            | f_mf_holding_change |         1.582 |       1.743 |                30 |      30 |         135.4 |
| mojo_losers            | f_mf_holding_pct    |         8.967 |       9.492 |                25 |      25 |         156.5 |
| mc_price_shockers      | f_mom_21d           |        18     |      19.395 |                19 |      19 |          28.4 |
| mc_price_shockers      | f_rs_vs_nifty       |        18     |      19.395 |                19 |      19 |          28.4 |
| nteod_gain5            | f_rsi               |         3.75  |       5.599 |                18 |      18 |          21.7 |
| mc_price_shockers      | f_rsi               |        14     |      17.532 |                17 |      17 |          27.6 |
| nteod_gain5            | f_mom_21d           |         5.167 |       5.463 |                16 |      16 |          21.2 |
| nteod_gain5            | f_rs_vs_nifty       |         5.167 |       5.463 |                16 |      16 |          21.2 |
| mc_price_shockers      | f_preopen_gap_pct   |         2.178 |       2.63  |                11 |      11 |          27.1 |
| nteod_loss5            | f_news_count        |         1.637 |       1.783 |                 8 |       8 |          34   |
| nteod_high_delivery    | f_news_count        |         4.701 |       4.701 |                 2 |       2 |          21   |
| nteod_high_delivery    | f_preopen_imbalance |         2.062 |       2.062 |                 2 |       2 |          21   |
| nteod_high_delivery    | f_vol_ratio         |        15.04  |      15.04  |                 1 |       1 |          31   |
| nteod_high_delivery    | f_mf_holding_pct    |         9.033 |       9.033 |                 1 |       1 |          31   |
| nteod_high_delivery    | f_delivery_pct      |         6     |       6     |                 1 |       1 |          31   |
| nteod_high_delivery    | f_mf_holding_change |         3.259 |       3.259 |                 1 |       1 |          31   |
| nteod_high_delivery    | f_rollover_pct      |         2.75  |       2.75  |                 1 |       1 |          31   |
| calc_volume_shocker    | f_vol_ratio         |         4.5   |       4.934 |                62 |      63 |          69.6 |
| calc_intraday_breakout | f_vol_ratio         |         3.5   |       4.301 |                45 |      46 |          43.3 |
| mojo_gainers           | f_news_count        |         3.14  |       3.387 |                38 |      39 |         102.4 |
| mojo_losers            | f_news_count        |         2.479 |       2.67  |                38 |      39 |         157.8 |
| calc_gap_up            | f_preopen_imbalance |         4     |       5.037 |                24 |      25 |          27.4 |
| calc_volume_shocker    | f_mom_5d            |         2.707 |       3.366 |               119 |     124 |          58.8 |
| mojo_gainers           | f_mf_holding_pct    |         8.294 |      10.178 |                21 |      22 |         126.6 |
| calc_volume_shocker    | f_rsi               |         2.578 |       3.004 |                62 |      65 |          68.8 |
| mc_price_shockers      | f_mom_5d            |         6.333 |       8.599 |                18 |      19 |          28.3 |
| nteod_gain5            | f_mom_5d            |         3.2   |       7.843 |                14 |      15 |          23.6 |
| mojo_gainers           | f_mf_holding_change |         1.8   |       1.802 |                27 |      29 |         103   |
| calc_intraday_breakout | f_rsi               |        21.472 |      22.903 |                26 |      28 |          42.8 |

## Engine top-N hit-rate summary

| engine          |   dates |   top_n |   hits_found |   movers |   mean_hit_rate_pct |   max_hit_rate_pct |
|:----------------|--------:|--------:|-------------:|---------:|--------------------:|-------------------:|
| confluence_rank |      62 |      20 |          513 |    30664 |                1.72 |               3.19 |
| intraday_rank   |      70 |      20 |          350 |    30750 |                1.05 |               2.51 |
| technical_rank  |      76 |      20 |          193 |    30810 |                0.53 |               1.74 |

## Canonical pre-open call accuracy — aggregate

|   dates |   movers |   matched |   opposite |   not_flagged |   matched_all_pct |   opposite_all_pct |   not_flagged_pct |   directional_precision_pct |
|--------:|---------:|----------:|-----------:|--------------:|------------------:|-------------------:|------------------:|----------------------------:|
|      49 |    25284 |      2739 |       2630 |         19915 |             10.83 |               10.4 |             78.77 |                       51.02 |

Historical recommendation snapshots were unavailable for **118** of 167 event dates; those dates are excluded from accuracy rather than being misreported as all Hold/not-flagged.

## Canonical pre-open call accuracy — by date

| event_date   |   matched |   opposite |   not_flagged |   n_movers |   snapshot_symbols | snapshot_asof                    |   matched_pct |   opposite_pct |   not_flagged_pct |
|:-------------|----------:|-----------:|--------------:|-----------:|-------------------:|:---------------------------------|--------------:|---------------:|------------------:|
| 2026-08-11   |        41 |         25 |           392 |        458 |               2200 | 2026-08-10T18:23:51.363893+00:00 |          8.95 |           5.46 |             85.59 |
| 2026-08-12   |        33 |         18 |           415 |        466 |               2202 | 2026-08-12T03:00:49.132879+00:00 |          7.08 |           3.86 |             89.06 |
| 2026-08-13   |        24 |         29 |           432 |        485 |               2205 | 2026-08-13T02:00:00.900914+00:00 |          4.95 |           5.98 |             89.07 |
| 2026-08-14   |        48 |         28 |           359 |        435 |               2205 | 2026-08-14T02:00:00.884303+00:00 |         11.03 |           6.44 |             82.53 |
| 2026-08-17   |        50 |         34 |           393 |        477 |               2225 | 2026-08-17T02:00:02.076469+00:00 |         10.48 |           7.13 |             82.39 |
| 2026-08-18   |        50 |         43 |           350 |        443 |               2229 | 2026-08-18T02:00:01.564459+00:00 |         11.29 |           9.71 |             79.01 |
| 2026-08-19   |        49 |         34 |           372 |        455 |               2236 | 2026-08-19T02:00:01.496408+00:00 |         10.77 |           7.47 |             81.76 |
| 2026-08-20   |        45 |         53 |           365 |        463 |               2239 | 2026-08-20T02:00:02.009136+00:00 |          9.72 |          11.45 |             78.83 |
| 2026-08-21   |        40 |         38 |           383 |        461 |               2216 | 2026-08-21T02:00:02.013600+00:00 |          8.68 |           8.24 |             83.08 |
| 2026-08-24   |        78 |         76 |           618 |        772 |               2215 | 2026-08-24T03:06:00.508207+00:00 |         10.1  |           9.84 |             80.05 |
| 2026-08-25   |        45 |         22 |           315 |        382 |               2156 | 2026-08-24T08:52:08.649785+00:00 |         11.78 |           5.76 |             82.46 |
| 2026-08-26   |        71 |         84 |           627 |        782 |               2156 | 2026-08-26T02:00:01.558531+00:00 |          9.08 |          10.74 |             80.18 |
| 2026-08-27   |       100 |         66 |           602 |        768 |               2151 | 2026-08-27T03:25:45.858764+00:00 |         13.02 |           8.59 |             78.39 |
| 2026-08-28   |        80 |         72 |           645 |        797 |               2132 | 2026-08-27T21:50:40.563016+00:00 |         10.04 |           9.03 |             80.93 |
| 2026-08-31   |       104 |         57 |           675 |        836 |               2150 | 2026-08-30T11:41:23.975472+00:00 |         12.44 |           6.82 |             80.74 |
| 2026-09-01   |        98 |        102 |           552 |        752 |               2130 | 2026-08-31T18:10:15.248153+00:00 |         13.03 |          13.56 |             73.4  |
| 2026-09-02   |        98 |         82 |           579 |        759 |               2111 | 2026-09-01T17:00:01.135758+00:00 |         12.91 |          10.8  |             76.28 |
| 2026-09-03   |        84 |        100 |           596 |        780 |               2099 | 2026-09-02T17:20:40.741635+00:00 |         10.77 |          12.82 |             76.41 |
| 2026-09-04   |        78 |        111 |           605 |        794 |               2084 | 2026-09-03T17:00:02.664803+00:00 |          9.82 |          13.98 |             76.2  |
| 2026-09-07   |       101 |         78 |           631 |        810 |               2080 | 2026-09-04T17:00:03.150316+00:00 |         12.47 |           9.63 |             77.9  |
| 2026-09-08   |        61 |         29 |           333 |        423 |               2068 | 2026-09-07T17:00:02.879848+00:00 |         14.42 |           6.86 |             78.72 |
| 2026-09-09   |        88 |         80 |           611 |        779 |               2054 | 2026-09-08T17:00:19.005897+00:00 |         11.3  |          10.27 |             78.43 |
| 2026-09-10   |        95 |         80 |           543 |        718 |               2062 | 2026-09-09T17:00:01.833884+00:00 |         13.23 |          11.14 |             75.63 |
| 2026-09-11   |        93 |         81 |           650 |        824 |               2040 | 2026-09-10T17:00:01.867380+00:00 |         11.29 |           9.83 |             78.88 |
| 2026-09-16   |        28 |         18 |           177 |        223 |               1997 | 2026-09-15T17:00:03.514035+00:00 |         12.56 |           8.07 |             79.37 |
| 2026-09-17   |        18 |         18 |           224 |        260 |               1987 | 2026-09-16T17:31:15.776894+00:00 |          6.92 |           6.92 |             86.15 |
| 2026-09-18   |        33 |         17 |           208 |        258 |               1928 | 2026-09-18T01:41:36.912483+00:00 |         12.79 |           6.59 |             80.62 |
| 2026-09-21   |        25 |         25 |           185 |        235 |               1973 | 2026-09-18T17:00:05.240202+00:00 |         10.64 |          10.64 |             78.72 |
| 2026-09-22   |        24 |         23 |           204 |        251 |               1973 | 2026-09-21T17:00:02.713370+00:00 |          9.56 |           9.16 |             81.27 |
| 2026-09-23   |        27 |         25 |           224 |        276 |               1981 | 2026-09-22T17:21:07.413881+00:00 |          9.78 |           9.06 |             81.16 |
| 2026-09-24   |        17 |         28 |           227 |        272 |               1990 | 2026-09-23T17:00:01.123757+00:00 |          6.25 |          10.29 |             83.46 |
| 2026-09-25   |        16 |         29 |           203 |        248 |               1970 | 2026-09-24T17:46:07.286994+00:00 |          6.45 |          11.69 |             81.85 |
| 2026-09-28   |        18 |         38 |           269 |        325 |               1975 | 2026-09-25T17:00:01.017708+00:00 |          5.54 |          11.69 |             82.77 |
| 2026-09-29   |        21 |         10 |           205 |        236 |               1956 | 2026-09-25T17:00:01.017708+00:00 |          8.9  |           4.24 |             86.86 |
| 2026-10-01   |        30 |         36 |           203 |        269 |               1972 | 2026-09-30T17:00:02.475451+00:00 |         11.15 |          13.38 |             75.46 |
| 2026-10-05   |        19 |         26 |           193 |        238 |               1895 | 2026-10-02T08:54:59.639792+00:00 |          7.98 |          10.92 |             81.09 |
| 2026-10-06   |        45 |         25 |           198 |        268 |               2332 | 2026-10-06T01:03:51.849185+00:00 |         16.79 |           9.33 |             73.88 |
| 2026-10-07   |        24 |         39 |           193 |        256 |               2331 | 2026-10-06T17:00:02.066905+00:00 |          9.38 |          15.23 |             75.39 |
| 2026-10-08   |        23 |         56 |           238 |        317 |               2329 | 2026-10-07T17:00:11.320480+00:00 |          7.26 |          17.67 |             75.08 |
| 2026-10-09   |        28 |         28 |           164 |        220 |               2329 | 2026-10-08T17:00:01.832701+00:00 |         12.73 |          12.73 |             74.55 |
| 2026-10-12   |        30 |         34 |           185 |        249 |               2329 | 2026-10-09T17:00:02.136266+00:00 |         12.05 |          13.65 |             74.3  |
| 2026-10-13   |        27 |         42 |           173 |        242 |               2329 | 2026-10-12T17:00:02.136190+00:00 |         11.16 |          17.36 |             71.49 |
| 2026-10-14   |        81 |         86 |           538 |        705 |               2328 | 2026-10-14T01:41:38.134839+00:00 |         11.49 |          12.2  |             76.31 |
| 2026-10-15   |        82 |        137 |           580 |        799 |               2328 | 2026-10-14T17:00:02.747888+00:00 |         10.26 |          17.15 |             72.59 |
| 2026-10-16   |        93 |         91 |           531 |        715 |               2330 | 2026-10-15T17:00:02.869081+00:00 |         13.01 |          12.73 |             74.27 |
| 2026-10-19   |        76 |        130 |           605 |        811 |               2385 | 2026-10-16T17:00:02.189319+00:00 |          9.37 |          16.03 |             74.6  |
| 2026-10-21   |       125 |         36 |           640 |        801 |               2387 | 2026-10-20T02:00:01.240216+00:00 |         15.61 |           4.49 |             79.9  |
| 2026-10-22   |        88 |         91 |           610 |        789 |               2374 | 2026-10-21T17:00:01.097161+00:00 |         11.15 |          11.53 |             77.31 |
| 2026-10-23   |        87 |        120 |           695 |        902 |               2364 | 2026-10-22T17:00:03.249378+00:00 |          9.65 |          13.3  |             77.05 |

Percentages are reported per date and include all three buckets: matched, opposite, and not flagged. Hold/missing calls are not flagged; only an actionable call in the wrong realized direction is opposite. Directional precision excludes Hold/missing but is shown beside total coverage so it cannot be presented as whole-universe accuracy.

### How to read this
- `mover_cohort` IC describes direction within already-selected movers; `eligible_universe` IC tests the complete point-in-time liquid equity comparison set.
- Event-session pre-open factors are measured against open-to-close returns; their auction gap is already known at 09:10 and cannot be credited as a forecast of the gap. All other factors use prior-close-to-close returns.
- Cohort lift uses that same eligible universe: NSE EQ membership on the event date, known ETFs excluded, a clean current/prior bar, and exactly 20 clean pre-event sessions with ADT of at least Rs 1 crore.
- Event-preopen lift for an open-defined class (for example, gap-up) is descriptive of an already-observed auction state, not evidence that the pre-open factor predicted the gap before it occurred.
- IC or lift is exploratory until it repeats across enough independent dates; never change a live weight from one date or a pooled row count.
- Hit-rate near 0% = the engine never saw the mover coming; that gap, not the math, is the first thing to fix.