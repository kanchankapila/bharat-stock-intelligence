export interface PremiumTrendlyneScreener {
  screenpk: string;
  name: string;
}

// Source: user-provided premium screener table (2026-08-05).
// Keep this list as the explicit allowlist for the Premium Screeners page.
const RAW_PREMIUM_SCREENER_TABLE = `
Trendlyne       | High DVM Mid and Small Caps (subscription)                   | 19746
Trendlyne       | High Momentum - Stocks with Highest Trendlyne Momentum Score | 280337
Trendlyne       | High Momentum - Stocks with Highest Trendlyne Momentum Score | 3057
Trendlyne       | High Trendlyne Checklist Score Stocks                        | 387668
Trendlyne       | Low PE stocks with PE TTM lower than 3 year, 5 year and 10 y | 548705
Trendlyne       | Upcoming Bonus/Split                                         | 45884
Trendlyne       | All Stars: High Scorers Across Metrics                       | 190803
Trendlyne       | Stocks in PE Buy Zone with Reasonable Durability Score, and  | 66655
Trendlyne       | Growth Factor Screener: Rising returns on equity (ROE), Mome | 16996
Trendlyne       | Stocks with improving cash flow, with good durability        | 7154
Trendlyne       | Stocks with high upside potential by Forecaster with high re | 208805
Trendlyne       | Forecaster Special - Strong sequential growth                | 211854
Trendlyne       | Forecaster Consensus Recommendation is Strong Buy, and Highe | 205167
Trendlyne       | Relative Outperformance versus Sector over the Quarter (3 Mo | 371832
Trendlyne       | Consistent high performing stocks over Five Years            | 32574
Trendlyne       | PE less than sector PE                                       | 222864
Trendlyne       | High Momentum - Stocks with Highest Trendlyne Momentum Score | 523595
Trendlyne       | Forecaster special - Sell side                               | 208109
Trendlyne       | Momentum Score (Technical Score) Daily Gainers               | 6159
Trendlyne       | Companies with improving valuation scores after share price  | 15045
Trendlyne       | Bearish Stocks - Stocks with Medium to Low Trendlyne Momentu | 3059
Trendlyne       | Low DVM Stocks - Stocks to Exercise Caution On               | 7205
Trendlyne       | Strong Performers - High DVM Stocks                          | 9818
Trendlyne       | Strong Performer, Getting Expensive (DVM)                    | 9823
Trendlyne       | Expensive Rockets (DVM)                                      | 9835
Trendlyne       | Expensive Underperformers (DVM)                              | 9837
Trendlyne       | Expensive Performers (DVM)                                   | 9836
Trendlyne       | Richard Dreihaus Screen: Momentum Driven Strategy            | 123150
Trendlyne       | Expensive Stars (DVM)                                        | 9824
Trendlyne       | Strong Performer, Under Radar Stocks (DVM)                   | 9819
Trendlyne       | Await Turnaround (DVM)                                       | 9896
Trendlyne       | Momentum Trap (DVM)                                          | 9840
Trendlyne       | Weak Stocks (DVM)                                            | 9843
Trendlyne       | Value Trap (DVM)                                             | 9895
Trendlyne       | Slowing Down Stocks (DVM)                                    | 9834
Trendlyne       | Falling Comet (DVM)                                          | 9831
Trendlyne       | Turnaround Potential (DVM)                                   | 9832
Trendlyne       | Mid-range Performer (DVM)                                    | 9826
Trendlyne       | Risky Value (DVM)                                            | 9838
Trendlyne       | Value Stocks, Under Radar (DVM)                              | 9821
Trendlyne       | Top losers of the past 5 years                               | 358904
Trendlyne       | Top losers of the past 10 years                              | 358905
Trendlyne       | Top gainers of the past 10 years                             | 358892
Trendlyne       | Top gainers of the past 5 years                              | 358891
Trendlyne       | Rising Delivery Percentage compared to Previous Day and Mont | 10663
Trendlyne       | Relative Outperformance versus Sector over 1 Week            | 186840
Trendlyne       | Relative Outperformance versus Industry over 1 Week          | 385658
Trendlyne       | Relative Outperformance versus Industry over 1 Month         | 385659
Trendlyne       | Relative Outperformance versus Sector over 1 Month           | 385663
Trendlyne       | Relative Underperformance versus Sector over 1 Week          | 198018
Trendlyne       | Relative Underperformance versus Sector over 1 Month         | 385676
Trendlyne       | Upcoming results with Rising Delivery Volumes                | 48091
Trendlyne       | Relative Underperformance versus Industry over 1 Month       | 385673
Trendlyne       | Significant Jump in Momentum Score                           | 334854
Trendlyne       | Securities seeing short covering                             | 208625
Trendlyne       | Stocks with high FnO put to call ratio or PCR, indicating a  | 208614
Trendlyne       | Results in the last two days with YoY and QoQ Net Profit Gro | 18792
Trendlyne       | Rising Momentum: Momentum Score Weekly Gainers               | 6160
Trendlyne       | Securities seeing a long buildup                             | 208626
Trendlyne       | Results Screener: Stocks with upcoming results which are see | 15697
Trendlyne       | Securities seeing a short build-up                           | 208631
Trendlyne       | Stocks with low FnO put to call ratio or PCR, indicating a b | 208613
Trendlyne       | PE less than Industry PE and High Forecaster Upside          | 182100
Trendlyne       | PE higher than sector PE                                     | 222865
Trendlyne       | PE less than Industry PE                                     | 178573
Trendlyne       | Price to Book Value (P/BV) higher than Industry Price to Boo | 218262
Trendlyne       | PE higher than Industry PE                                   | 178571
Trendlyne       | ROCE (Return on Capital Employed) higher than Industry ROCE  | 218473
Trendlyne       | ROE (Return on Equity) is higher than Industry ROE           | 218481
Trendlyne       | ROCE (Return on Capital Employed) higher than Sector ROCE    | 218266
Trendlyne       | ROE (Return on Equity) is lower than Industry ROE            | 218482
Trendlyne       | ROCE (Return on Capital Employed) less than Industry ROCE    | 218470
Trendlyne       | Price to Book Value (P/BV) less than Sector Price to Book Va | 218265
Trendlyne       | ROE (Return on Equity) is higher than Sector ROE             | 218476
Trendlyne       | ROA (Return on Assets) higher than Industry ROA              | 218489
Trendlyne       | PEG greater than Industry PEG                                | 258192
Trendlyne       | ROA (Return on Assets) less than Industry ROA                | 218492
Trendlyne       | Stocks with PEG higher than Industry PEG                     | 178572
Trendlyne       | ROA (Return on Assets) higher than Sector ROA                | 218484
Trendlyne       | ROA (Return on Assets) less than Sector ROA                  | 218488
Trendlyne       | ROE (Return on Equity) is lower than Sector ROE              | 218479
Trendlyne       | PEG lower than Industry PEG                                  | 258198
Trendlyne       | PEG higher than Sector PEG                                   | 258206
Trendlyne       | Dividend yield greater than industry dividend yield          | 258174
Trendlyne       | Dividend yield greater than sector dividend yield            | 258180
Trendlyne       | Dividend yield less than industry dividend yield             | 258175
Trendlyne       | PEG lower than Sector PEG                                    | 258205
Trendlyne       | Dividend yield less than sector dividend yield               | 258176
Trendlyne       | Quarterly Profit Growth YoY higher than Industry Profit Grow | 222872
Trendlyne       | Quarterly Profit Growth YoY higher than Sector Profit Growth | 222869
Trendlyne       | Annual Profit Growth higher than Industry Profit Growth      | 218511
Trendlyne       | Quarterly Profit Growth YoY less than Industry Profit Growth | 222874
Trendlyne       | Annual Profit Growth higher than Sector Profit Growth        | 218498
Trendlyne       | Quarterly Profit Growth YoY less than Sector Profit Growth Y | 222870
Trendlyne       | Annual Profit Growth less than Industry Profit Growth        | 218513
Trendlyne       | Quarter Revenue Growth YoY higher than Sector Revenue Growth | 222875
Trendlyne       | Quarter Revenue Growth YoY higher than Industry Revenue Grow | 222877
Trendlyne       | Annual Profit Growth less than Sector Profit Growth          | 218510
Trendlyne       | Annual Revenue Growth higher than Industry Revenue Growth    | 222859
Trendlyne       | Annual Revenue Growth higher than Sector Revenue Growth      | 218517
Trendlyne       | Quarter Revenue Growth YoY less than Industry Revenue Growth | 222879
Trendlyne       | Quarter Revenue Growth YoY less than Sector Revenue Growth   | 222876
Trendlyne       | Annual Revenue Growth less than Industry Revenue Growth      | 222861
Trendlyne       | Relative Outperformance versus Sector over Day               | 371821
Trendlyne       | Relative Outperformance versus Sector over Half Year (6 Mont | 371835
Trendlyne       | Annual Revenue Growth lower than Sector Revenue Growth       | 218535
Trendlyne       | Relative Outperformance versus sector over 1 Year            | 252766
Trendlyne       | Relative Underperformance versus Sector over Day             | 371842
Trendlyne       | Relative Underperformance versus Sector over Quarter (3 Mont | 372099
Trendlyne       | Relative Underperformance versus Sector over Half Year (6 Mo | 372101
Trendlyne       | Relative Outperformance versus Sector over 5 Years           | 252969
Trendlyne       | Relative Outperformance versus Sector over 2 Years           | 252940
Trendlyne       | Relative Underperformance versus Sector over 1 Year          | 253069
Trendlyne       | Relative Outperformance versus Sector over 10 Years          | 252997
Trendlyne       | Relative Outperformance versus Sector over 3 Years           | 252942
Trendlyne       | Relative Outperformance versus Industry over Day             | 372130
Trendlyne       | Relative Outperformance versus Industry over the Quarter (3  | 179144
Trendlyne       | Relative Outperformance versus Industry over 1 Year          | 178574
Trendlyne       | Relative Outperformance versus Industry over Half Year (6 Mo | 372137
Trendlyne       | Relative Underperformance versus Sector over 3 Years         | 253026
Trendlyne       | Relative Underperformance versus Sector over 2 Years         | 253053
Trendlyne       | Relative Outperformance versus Industry over 10 Years        | 178588
Trendlyne       | Relative Underperformance versus Sector over 10 Years        | 253024
Trendlyne       | Relative Underperformance versus Sector over 5 Years         | 253025
Trendlyne       | Relative Underperformance versus Industry over Quarter (3 Mo | 372174
Trendlyne       | Relative Underperformance versus Industry over Day           | 372170
Trendlyne       | Relative Underperformance versus Industry over Half Year (6  | 372175
Trendlyne       | Relative Outperformance versus Industry over 2 Years         | 252158
Trendlyne       | Relative Outperformance versus Industry over 5 Years         | 252170
Trendlyne       | Relative Outperformance versus Industry over 3 Years         | 252169
Trendlyne       | Relative Underperformance versus Industry over 2 Years       | 252750
Trendlyne       | Relative Underperformance versus Industry over 1 Year        | 252751
Trendlyne       | Relative Underperformance versus Industry over 5 Years       | 252748
Trendlyne       | Relative Underperformance versus Industry over 3 Years       | 252749
Trendlyne       | Relative Underperformance versus Industry over 10 Years      | 252747
Trendlyne       | Best Bargains Screener: Above line growth, Below line valuat | 30
Trendlyne       | Announced results in last two weeks, with rising operating p | 17131
Trendlyne       | Results declared today                                       | 287918
Trendlyne       | Results declared today, with net profit and revenue growth Y | 22709
Trendlyne       | Best results last week in YoY net profit and revenue growth  | 8256
Trendlyne       | Stocks outperforming the index over the week, post results   | 150420
Trendlyne       | Upcoming results for Nifty500 companies with previous quarte | 15628
Trendlyne       | Upcoming results for rising companies with previous quarter  | 630954
Trendlyne       | Quarter Revenue and Net profit Growth YoY higher than Indust | 633902
Trendlyne       | Live Results Screener: Companies with rising operating profi | 9193
Trendlyne       | Companies that Declared Results in Past One Week, Showing De | 15543
Trendlyne       | Companies with Upcoming Results                              | 18121
Trendlyne       | Turnaround Companies: Loss to Profit QoQ                     | 9287
Trendlyne       | IT stocks that saw rising net profit and revenue in the most | 636494
Trendlyne       | Results declared today, with declining net profits (YoY OR Q | 25797
Trendlyne       | Good quarterly growth in the recent results                  | 16
Trendlyne       | Companies that saw improvement in net profits, operating pro | 10029
Trendlyne       | Banking & finance stocks that saw rising net profit and reve | 560405
Trendlyne       | Upcoming Results for Nifty500 with Declining Share Price Ove | 82586
Trendlyne       | Stocks with strong dividend yields in FY25 and healthy growt | 25818
Trendlyne       | Upcoming Dividends                                           | 45882
Trendlyne       | Lowest Momentum Scores (Technical Scores)                    | 6157
Trendlyne       | Supertrend Signal changed to Buy                             | 482896
Trendlyne       | Price crossed above Bollinger Band                           | 481430
Trendlyne       | Price nearing Supertrend resistance                          | 482900
Trendlyne       | Price nearing Supertrend support                             | 482899
Trendlyne       | Price crossed below Bollinger Band                           | 481431
Trendlyne       | Supertrend Signal changed to Sell                            | 482898
Trendlyne       | Price crossed above Bollinger Band Central Line              | 481432
Trendlyne       | Bollinger Band Breakdown                                     | 481436
Trendlyne       | Price crossed below Bollinger Band Central Line              | 481434
Trendlyne       | Bollinger Band Breakout                                      | 481435
Trendlyne       | Day Supertrend Sells                                         | 482895
Trendlyne       | Supertrend Buys                                              | 482894
Trendlyne       | ADX Bearish Divergence                                       | 482905
Trendlyne       | ADX Bullish Divergence                                       | 482904
Trendlyne       | ROC Trending Down                                            | 482916
Trendlyne       | ROC Trending Up                                              | 482914
Trendlyne       | Stochastic oscillator bearish momentum                       | 701758
Trendlyne       | Stochastic oscillator bearish crossover                      | 701756
Trendlyne       | Stochastic oscillator bullish momentum                       | 701757
Trendlyne       | Overbought by Week Money Flow Index (MFI)                    | 593017
Trendlyne       | Oversold by Week Money Flow Index (MFI)                      | 593015
Trendlyne       | Week Relative Strength Index (RSI) Bullish                   | 593007
Trendlyne       | Week MACD Crossover Above Signal Line                        | 593000
Trendlyne       | Oversold on both Week RSI and Week MFI                       | 593018
Trendlyne       | Week MACD Crossover Below Signal Line                        | 593002
Trendlyne       | Overbought on both Week MFI and Week RSI                     | 593009
Trendlyne       | Stochastic oscillator overbought                             | 701755
Trendlyne       | Week Bollinger Band Breakout                                 | 593027
Trendlyne       | Stochastic oscillator bullish crossover                      | 701754
Trendlyne       | Stochastic oscillator oversold                               | 701753
Trendlyne       | Price crossed above Week Bollinger Band Central Line         | 593024
Trendlyne       | Price crossed above Week Bollinger Band                      | 593022
Trendlyne       | Week Supertrend Signal changed to Buy                        | 593021
Trendlyne       | Week Bollinger Band Breakdown                                | 593031
Trendlyne       | Week Supertrend Buys                                         | 593036
Trendlyne       | Price crossed below Week Bollinger Band                      | 593023
Trendlyne       | Price crossed below Week Bollinger Band Central Line         | 593026
Trendlyne       | Week Supertrend Signal changed to Sell                       | 593033
Trendlyne       | Week ADX Strong Trending Stocks                              | 593485
Trendlyne       | Week Supertrend Sells                                        | 593034
Trendlyne       | Week ADX Trending Stocks                                     | 593486
Trendlyne       | Week ADX Mild Trending Stocks                                | 593487
Trendlyne       | Week Williams %R in Overbought zone                          | 593038
Trendlyne       | Week Willaims %R in Oversold zone                            | 593037
Trendlyne       | Week Williams %R Bullish                                     | 593044
Trendlyne       | Week Williams %R Bearish                                     | 593042
Trendlyne       | Week Williams %R crossed -80 from above                      | 593040
Trendlyne       | Week ADX Bullish Divergence                                  | 593484
Trendlyne       | Week Williams Trending Down                                  | 593041
Trendlyne       | Week ROC Trending Up                                         | 593504
Trendlyne       | Week CCI Oversold                                            | 593488
Trendlyne       | Week CCI Overbought                                          | 593489
Trendlyne       | Week ADX Bearish Divergence                                  | 593045
Trendlyne       | Week CCI crossed above 100                                   | 593499
Trendlyne       | Week CCI Bullish                                             | 593502
Trendlyne       | Week CCI Trending Up                                         | 593501
Trendlyne       | Week ROC Trending Down                                       | 593503
Trendlyne       | Week CCI Bearish                                             | 593497
Trendlyne       | Week CCI Trending Down                                       | 593494
Trendlyne       | Week CCI crossed below -100                                  | 593493
Trendlyne       | Overbought by Month Money Flow Index (MFI)                   | 594821
Trendlyne       | Oversold by Month Money Flow Index (MFI)                     | 594819
Trendlyne       | Week Stochastic oscillator bearish crossover                 | 701764
Trendlyne       | Month Relative Strength Index (RSI) Bearish                  | 594811
Trendlyne       | Week Stochastic oscillator bullish momentum                  | 701768
Trendlyne       | Oversold on both Month RSI and Month MFI                     | 594824
Trendlyne       | Week Stochastic oscillator overbought                        | 701763
Trendlyne       | Week Stochastic oscillator bullish crossover                 | 701762
Trendlyne       | Overbought on both Month MFI and Month RSI                   | 594816
Trendlyne       | Week Stochastic oscillator oversold                          | 701760
Trendlyne       | Week Stochastic oscillator bearish momentum                  | 701770
Trendlyne       | Month Relative Strength Index (RSI) Bullish                  | 594815
Trendlyne       | Price crossed above Month Bollinger Band                     | 594835
Trendlyne       | Month MACD Crossover Above Signal Line                       | 594807
Trendlyne       | Price crossed below Month Bollinger Band                     | 594842
Trendlyne       | Month Supertrend Buys                                        | 595302
Trendlyne       | Month Supertrend Signal changed to Sell                      | 594849
Trendlyne       | Month Supertrend Sells                                       | 594855
Trendlyne       | Month MACD Crossover Below Signal Line                       | 594809
Trendlyne       | Price crossed below Month Bollinger Band Central Line        | 594845
Trendlyne       | Month Bollinger Band Breakdown                               | 594848
Trendlyne       | Month Supertrend Signal changed to Buy                       | 594829
Trendlyne       | Price crossed above Month Bollinger Band Central Line        | 594844
Trendlyne       | Month Bollinger Band Breakout                                | 594847
Trendlyne       | Month ADX Strong Trending Stocks                             | 595615
Trendlyne       | Month ADX Trending Stocks                                    | 595617
Trendlyne       | Month Williams %R in Overbought zone                         | 595304
Trendlyne       | Month ADX Mild Trending Stocks                               | 595618
Trendlyne       | Month Willaims %R in Oversold zone                           | 595303
Trendlyne       | Month Williams %R Bullish                                    | 595310
Trendlyne       | Month Williams %R Bearish                                    | 595308
Trendlyne       | Month Williams Trending Down                                 | 595306
Trendlyne       | Month Williams %R crossed -80 from above                     | 595305
Trendlyne       | Month Williams %R crossed -20 from below                     | 595309
Trendlyne       | Month ADX Bullish Divergence                                 | 595614
Trendlyne       | Month CCI Oversold                                           | 595661
Trendlyne       | Month CCI Overbought                                         | 595662
Trendlyne       | Month ADX Bearish Divergence                                 | 595613
Trendlyne       | Month ROC Trending Up                                        | 595672
Trendlyne       | Month CCI Bullish                                            | 595670
Trendlyne       | Month CCI crossed above 100                                  | 595667
Trendlyne       | Month CCI Bearish                                            | 595666
Trendlyne       | Month ROC Trending Down                                      | 595671
Trendlyne       | Month CCI crossed below -100                                 | 595663
Trendlyne       | Month CCI Trending Down                                      | 595664
Trendlyne       | Month Stochastic oscillator bearish crossover                | 701782
Trendlyne       | Month Stochastic oscillator bearish momentum                 | 701785
Trendlyne       | Month Stochastic oscillator overbought                       | 701780
Trendlyne       | Month Stochastic oscillator oversold                         | 701772
Trendlyne       | Month Stochastic oscillator bullish momentum                 | 701783
Trendlyne       | Month Stochastic oscillator bullish crossover                | 701773
Trendlyne       | pledged shares increased in past week                        | 31717
Trendlyne       | Pledges today more than 1% of total shares                   | 26001
Trendlyne       | Big Deal (Insider Trades) sells last week greater than 1% of | 472327
Trendlyne       | Big Deal (Insider Trades) sells last month greater than 1% o | 471978
Trendlyne       | Big Deal (Insider Trades) buys last week greater than 1% of  | 472341
Trendlyne       | Insider sells yesterday greater than 0.1% of total shares    | 472344
Trendlyne       | Insider and SAST sells yesterday greater than 0.1% of total  | 20078
Trendlyne       | Big Deal (Insider Trades) buys last month greater than 1% of | 472333
Trendlyne       | Insiders sold stocks                                         | 46425
Trendlyne       | Annual revenue and net profit positive surprise              | 556779
Trendlyne       | ASM (Additional Surveillance Measure)/GSM (Graded Surveillan | 608231
Trendlyne       | Revenue and EPS positive surprise for the Quarter            | 556782
Trendlyne       | Revenue Positive Surprise for the Quarter                    | 556802
Trendlyne       | Annual revenue and EPS positive surprise                     | 556783
Trendlyne       | Net Profit Positive Surprise for the Quarter                 | 556798
Trendlyne       | EPS Positive Surprise for the Quarter                        | 556806
Trendlyne       | Net Profit Positive Surprise for the Year                    | 556812
Trendlyne       | Revenue Positive Surprise for the Year                       | 556819
Trendlyne       | EPS Positive Surprise for the Year                           | 556858
Trendlyne       | Forecaster: Analysts Estimate Positive Capex Growth          | 556862
Trendlyne       | Forecaster: Analysts Estimate Dividend Yield Growth (YoY)    | 556869
Trendlyne       | Forecaster: Analysts See Consensus Upside to Share Price     | 556865
Trendlyne       | Forecaster: Analysts Estimate Falling Interest Expense (QoQ) | 556891
Trendlyne       | Forecaster: Analysts Estimate  Falling Interest Expense (YoY | 556895
Trendlyne       | Revenue and net profit positive surprise for the Quarter     | 556358
Trendlyne       | Forecaster Consensus Estimates: Stocks with Strong Buy Calls | 207497
Trendlyne       | Rising general industrial stocks with strong Forecaster EPS  | 688033
Trendlyne       | Forecaster: Analysts estimate positive quarterly revenue and | 669051
Trendlyne       | Forecaster: Analysts estimate positive annual revenue and EP | 669112
Trendlyne       | Forecaster: Analysts estimate positive EPS growth (QoQ)      | 669140
Trendlyne       | Forecaster: Analysts estimate positive revenue and EPS growt | 669137
Trendlyne       | Forecaster: Analysts estimate positive revenue growth (QoQ)  | 669138
Trendlyne       | Forecaster: Analysts estimate positive quarterly revenue gro | 669064
Trendlyne       | Forecaster: Analysts estimate positive quarterly EPS growth  | 669067
Trendlyne       | Highest Capex Growth Estimates - Forecaster                  | 253272
Trendlyne       | Revenue and net profit negative surprise for the Quarter     | 556785
Trendlyne       | Annual revenue and net profit negative surprise              | 556790
Trendlyne       | Revenue and EPS negative surprise for the Quarter            | 556793
Trendlyne       | Forecaster Consensus Recommendation is Strong Buy or Buy     | 253264
Trendlyne       | Highest Upside in Target Price Estimates - Forecaster        | 253307
Trendlyne       | Highest Long Term Growth Estimates - Forecaster              | 253311
Trendlyne       | Annual revenue and EPS negative surprise                     | 556795
Trendlyne       | Net Profit Negative Surprise for the Quarter                 | 556799
Trendlyne       | Strong Forecaster EPS Growth Estimates from Analysts         | 253269
Trendlyne       | Highest Dividend Yield Estimates - Forecaster                | 253296
Trendlyne       | Strong Forecaster Revenue Growth Estimates from Analysts     | 253267
Trendlyne       | Revenue Negative Surprise for the Quarter                    | 556803
Trendlyne       | EPS Negative Surprise for the Quarter                        | 556810
Trendlyne       | Revenue Negative Surprise for the Year                       | 556820
Trendlyne       | Net Profit Negative Surprise for the Year                    | 556813
Trendlyne       | EPS Negative Surprise for the Year                           | 556861
Trendlyne       | Forecaster: Analysts Estimate Negative Capex Growth          | 556864
Trendlyne       | Forecaster: Analysts Estimate Dividend Yield Decline (YoY)   | 556873
Trendlyne       | Forecaster: Analysts See Consensus Downside to Share Price   | 556868
Trendlyne       | Forecaster: Analysts Estimate Rising Interest Expense (QoQ)  | 556888
Trendlyne       | Forecaster: Analysts Estimate Falling Free Cash Flow (YoY)   | 556885
Trendlyne       | Forecaster Consensus Recommendation is Strong Sell, and Weak | 253337
Trendlyne       | Forecaster Consensus Estimates: Stocks with Sell or Strong S | 253313
Trendlyne       | Forecaster: Analysts Estimate Rising Interest Expense (YoY)  | 556894
Trendlyne       | Forecaster: Analysts estimate negative annual revenue and EP | 669114
Trendlyne       | Forecaster: Analysts estimate negative EPS growth (QoQ)      | 669143
Trendlyne       | Forecaster: Analysts estimate negative revenue growth (QoQ)  | 669142
Trendlyne       | Forecaster: Anlaysts estimate negative revenue and EPS growt | 669141
Trendlyne       | Forecaster: Analysts estimate negative quarterly revenue and | 669060
Trendlyne       | Forecaster: Analysts estimate negative quarterly EPS growth  | 669070
Trendlyne       | Forecaster: Analysts estimate negative quarterly revenue gro | 669066
Trendlyne       | Stocks that are currently under trade ban by the exchanges i | 208618
Trendlyne       | Weak Forecaster Revenue Growth Estimates from Analysts       | 253350
Trendlyne       | Lowest Long Term Growth Estimates - Forecaster               | 253354
Trendlyne       | Weak Forecaster EPS Growth Estimates from Analysts           | 253352
Trendlyne       | Stocks that are at the risk of entering a trade ban by the e | 208619
Trendlyne       | Forecaster target price below current price                  | 258822
Trendlyne       | Industry outperformers in terms of annual growth and capital | 515743
Trendlyne       | Potential Outperformers: Upcoming results from high revenue  | 479184
Trendlyne       | Companies with current TTM PE Ratio less than 3 Year, 5 Year | 17183
Trendlyne       | Stocks with Quarter Change % less than Industry              | 179158
Trendlyne       | Stocks with High Durability and EPS growth (subscription)    | 10699
Trendlyne       | Fast growing companies with steady momentum                  | 650308
Trendlyne       | DVM Performers for All Stocks (weekly, higher risk) - subscr | 4807
Trendlyne       | Companies with PE less than Nifty500 PE, Price to Book less  | 14752
Trendlyne       | Stocks with Consistent Share Price Growth (subscription)     | 24842
Trendlyne       | Growth Stars: Strongest Annual EPS Performers                | 11321
Trendlyne       | Affordable stocks with good momentum and ROE - All Stocks (s | 8036
Trendlyne       | Combined DVM and Piotroski Scores Screener (subscription)    | 6562
Trendlyne       | DVM - High Performing, Highly Durable Companies (subscriptio | 11793
Trendlyne       | Trendlynes growth stocks with good technical score           | 29
Trendlyne       | Newly Affordable Stocks with Good Financials and Durability  | 11122
Trendlyne       | High DVM Performers - Expensive but with Good Durability (su | 18566
Trendlyne       | High DVM Midcap Stocks (MarketCap 1000-10,000)               | 8182
Trendlyne       | Stocks seeing month price declines, good financial durabilit | 17233
Trendlyne       | Top Performer DVM Stocks (subscription)                      | 7830
Trendlyne       | Lower Risk: High DVM Stocks in Large Caps (Market Cap > 1000 | 8181
Trendlyne       | Stringent DVM Screener                                       | 7942
Trendlyne       | Higher Risk - High DVM Small Cap Stocks                      | 8185
Trendlyne       | Higher DVM Stocks Among Midcaps and Largecaps                | 10159
Trendlyne       | Trendlynes technically strong value stocks (subscription)    | 26
Trendlyne       | Technical Screener: Momentum Stocks with Significant Volumes | 9516
Trendlyne       | Pharma Stocks with Rising Momentum                           | 14535
Trendlyne       | Weekly Momentum Gainers                                      | 8008
Trendlyne       | Weekly Screener: High Momentum Score Stocks (subscription)   | 7557
Trendlyne       | Performance of Stocks with Low Trendlyne Durability Score ve | 3051
Trendlyne       | Affordable Stocks - Stocks with Good Trendlyne Valuation Sco | 3056
Trendlyne       | The Bull Cartel                                              | 691159
`;

function parsePremiumTable(raw: string): PremiumTrendlyneScreener[] {
  const map = new Map<string, PremiumTrendlyneScreener>();
  for (const line of raw.split('\n')) {
    if (!line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const provider = parts[0];
    const name = parts[1];
    const screenpk = parts[2].replace(/[^0-9]/g, '');
    if (!provider.toLowerCase().includes('trendlyne')) continue;
    if (!name || !screenpk) continue;
    if (!map.has(screenpk)) {
      map.set(screenpk, { screenpk, name });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export const PREMIUM_TRENDLYNE_SCREENERS: PremiumTrendlyneScreener[] = parsePremiumTable(RAW_PREMIUM_SCREENER_TABLE);

export const PREMIUM_TRENDLYNE_SCREENPK_SET = new Set(PREMIUM_TRENDLYNE_SCREENERS.map((s) => s.screenpk));
