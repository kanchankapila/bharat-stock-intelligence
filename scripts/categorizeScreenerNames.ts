import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

interface ScreenerRow {
  source: string;
  screener_id: string;
  screener_name: string;
}

interface CategoryRule {
  category: string;
  subcategory: string;
  patterns: RegExp[];
  weight?: number;
}

interface Classification {
  category: string;
  subcategory: string;
  signal_bias: 'bullish' | 'bearish' | 'neutral';
  investment_horizon: 'intraday' | 'swing' | 'positional' | 'long_term';
  confidence: number;
}

const dbPath = path.resolve(process.cwd(), 'database.sqlite');
const outputPath = path.resolve(process.cwd(), 'screener_names_categorized.csv');

const rules: CategoryRule[] = [
  { category: 'derivatives_positioning', subcategory: 'open_interest', patterns: [/\bopen interest\b/, /\boi\b/, /\blong buildup\b/, /\blong build-up\b/, /\bshort buildup\b/, /\bshort build-up\b/, /\bshort covering\b/, /\blong unwinding\b/, /\bpcr\b/, /\bput.?call\b/, /\bfno\b/, /\bfutures and options\b/, /\btrade ban\b/] },
  { category: 'ownership_institutional', subcategory: 'institutional_activity', patterns: [/\bfii?s?\b/, /\bfpi\b/, /\bdiis?\b/, /\bmutual fund/, /\bmfs?\b/, /\binstitution/, /\bforeign investor/, /\bsuperstar investor/, /\binsider/, /\bpromoter (?:buy|sell|increas|decreas|holding|stake|pledge)/, /\bshareholding/, /\bpublic holding\b/] },
  { category: 'ownership_institutional', subcategory: 'bulk_block_deals', patterns: [/\bbulk deal/, /\bblock deal/] },
  { category: 'analyst_sentiment', subcategory: 'broker_forecast', patterns: [/\bbrokers?\b/, /\bforecaster\b/, /\banalysts?\b/, /\btarget price\b/, /\bconsensus\b/, /\bstreet favorite\b/, /\breco\b/] },
  { category: 'event_corporate_action', subcategory: 'corporate_action', patterns: [/\bbonus\b/, /\bsplit\b/, /\bbuyback\b/, /\bright issue\b/, /\bdividend announcement\b/, /\bboard meeting\b/] },
  { category: 'event_corporate_action', subcategory: 'earnings_event', patterns: [/\bresult/, /\bsurprise\b/, /\bupcoming dividends?\b/] },
  { category: 'income_dividend', subcategory: 'dividend_income', patterns: [/\bdividend\b/, /\byield stocks?\b/] },
  { category: 'risk_red_flags', subcategory: 'financial_or_governance_risk', patterns: [/\bred flag/, /\bwealth destroy/, /\bvalue trap/, /\bmomentum trap/, /\bavoid\b/, /\bcaution\b/, /\bpledge/, /\bdeclining profit/, /\bdecreasing (?:eps|revenue|sales|profit|roe|roce)/, /\bincreasing debt/, /\bweak fundamental/, /\bpoor cash/, /\bloss(?:es| making)/, /\bprofit to loss\b/, /\bhigh debt/, /\bhigh leverage\b/, /\bdebt load\b/, /\bnpa\b/, /\bprovisions?\b/, /\bwarning letter\b/, /\bsurveillance\b/, /\basm\b/, /\bgsm\b/, /\boperations unsuccessful\b/, /\bmanagement is under dispute\b/, /\bdistressed operations\b/] },
  { category: 'fundamental_quality', subcategory: 'balance_sheet_quality', patterns: [/\bzero debt\b/, /\bno debt\b/, /\bdebt.?free\b/, /\blow debt\b/, /\bdecreasing debt\b/, /\bdebt reduction\b/, /\blow leverage\b/, /\bno leverage\b/, /\bmoderate leverage\b/, /\bcash rich\b/, /\bcash cow/, /\bcash king/, /\bpositive cash flow\b/, /\bfree cash flow\b/, /\bnet cash flow\b/, /\bimproving cash flow\b/, /\bpiotroski\b/, /\bpitroski\b/, /\bfinancial health\b/, /\bgood financials\b/, /\bbalance sheet\b/] },
  { category: 'fundamental_quality', subcategory: 'capital_efficiency', patterns: [/\broe\b/, /\broce\b/, /\broa\b/, /\breturn on (?:equity|capital|assets)/, /\befficient use of capital\b/, /\bcapital allocation\b/, /\bprofit margins?\b/, /\bmargin expansion\b/, /\bmargin king/, /\boperations successful\b/] },
  { category: 'fundamental_growth', subcategory: 'earnings_growth', patterns: [/\bprofit growth\b/, /\beps growth\b/, /\beps champion/, /\bearnings growth\b/, /\bprofit increas/, /\brising profit/, /\bprofit acceleration\b/, /\bprofit pioneer/, /\bprofit pearl/, /\bprofit spinner/, /\brocket profit\b/, /\b10x profit\b/, /\bquarterly growers?\b/] },
  { category: 'fundamental_growth', subcategory: 'revenue_growth', patterns: [/\bsales growth\b/, /\brevenue growth\b/, /\btop.?line growth\b/, /\brising revenue\b/, /\brising sales\b/, /\bsales increas/, /\bsales pioneer/, /\bnon-core income\b/] },
  { category: 'valuation', subcategory: 'relative_or_absolute_value', patterns: [/\bvalue stocks?\b/, /\bvaluation/, /\bundervalu/, /\bovervalu/, /\baffordable\b/, /\bbargain/, /\bdiscount/, /\bpremium\b/, /\bre.?rating\b/, /\bmargin of safety\b/, /\blow pe\b/, /\bhigh pe\b/, /\bpe (?:ratio|century|buy zone|sell zone)\b/, /\bp\/e\b/, /\bprice.?to.?earnings\b/, /\bpeg\b/, /\blow pb\b/, /\bhigh pb\b/, /\bp\/b\b/, /\bp\/bv\b/, /\bprice.?to.?book\b/, /\bprice.?to.?sales\b/, /\bsales more than market cap\b/, /\bfixed assets are higher than their market cap\b/, /\bbook value\b/, /\bintrinsic value\b/, /\bgraham\b/, /\bdvm\b/] },
  { category: 'technical_reversal', subcategory: 'candlestick_reversal', patterns: [/\breversal\b/, /\bcontinuation\b/, /\bengulfing\b/, /\bhammer\b/, /\bdoji\b/, /\bharami\b/, /\bmarubozu\b/, /\bmorning star\b/, /\bevening star\b/, /\bshooting star\b/, /\bhanging man\b/, /\bthree (?:white soldiers|black crows)\b/, /\bpiercing\b/, /\bdark ?cloud\b/, /\babandoned baby\b/, /\bkicking\b/, /\btasuki\b/, /\bcandlestick\b/, /\bthree candle\b/] },
  { category: 'technical_reversal', subcategory: 'oscillator_reversal', patterns: [/\boversold\b/, /\boverbought\b/, /\bdivergence\b/, /\brsi reversal\b/, /\bmfi reversal\b/, /\bcci reversal\b/, /\bstochastic reversal\b/, /\bbounce\b/, /\bturnaround\b/, /buy on dips/, /\bcontrarian\b/] },
  { category: 'technical_breakout', subcategory: 'price_breakout', patterns: [/\bbreakout/, /\bbreak out\b/, /\bbreakdown/, /\bbreak down\b/, /\bresistance\b/, /\bsupport\b/, /\bpivot\b/, /\btriangle\b/, /\bsqueeze\b/, /\bconsolidation\b/, /\bdarvas\b/, /\bturtle trading\b/, /\brange breakout\b/, /\bclose above\b/, /\bclose below\b/, /\bclose crossing\b/, /\bopen = low\b/, /\bbtst\b/, /\bstbt\b/, /\bperfect buy\b/, /\bperfect sell\b/, /\bbreakaway\b/] },
  { category: 'technical_momentum', subcategory: 'relative_strength', patterns: [/\brelative (?:outperformance|underperformance|strength)\b/, /\boutperform/, /\bunderperform/, /\bmomentum\b/, /\bmultibagger breakout\b/] },
  { category: 'technical_momentum', subcategory: 'price_leadership', patterns: [/\bstrong stocks?\b/, /\bweak stocks?\b/, /\bbold bulls?\b/, /\bbold bears?\b/, /\bgainer/, /\bloser/, /\bnew highs?\b/, /\b52.?week (?:high|low)\b/, /\b(?:all.?time|(?:2|3|5|10)-?year|new (?:1[ -]week|1[ -]month|3[ -]month|6[ -]month|quarterly|(?:2|3|5|10)[ -]?year)) (?:high|low)\b/, /\bprice (?:surge|rise|fall|gain|decline)\b/, /\bupper circuit\b/, /\blower circuit\b/, /\b100%\+ returns\b/, /\btrading within 5%/, /\bhigher than week low\b/] },
  { category: 'technical_trend', subcategory: 'moving_average_trend', patterns: [/\bema\d*/, /\bsma\d*/, /\bmoving average\b/, /\bgolden cross\b/, /\bdeath cross\b/, /\bma crossover\b/] },
  { category: 'technical_trend', subcategory: 'trend_indicator', patterns: [/\badx\b/, /\bsupertrend\b/, /\btrend rider\b/, /\btrend(?:ing)? (?:up|down)\b/, /\buptrend\b/, /\bdowntrend\b/, /\bbullish trend\b/, /\bbearish trend\b/, /\bmacd\b/, /\bichimoku\b/] },
  { category: 'technical_reversal', subcategory: 'oscillator_signal', patterns: [/\brsi\b/, /\bmfi\b/, /\bcci\b/, /\bstoch/, /\bwilliams %?r\b/, /\brelative strength index\b/, /\bcommodity channel\b/] },
  { category: 'volume_liquidity', subcategory: 'volume_delivery', patterns: [/\bvolumes?\b/, /\bdelivery\b/, /\bturnover\b/, /\bliquidity\b/, /\bmost active\b/] },
  { category: 'volatility', subcategory: 'volatility_range', patterns: [/\bvolatility\b/, /\batr\b/, /\bbollinger\b/, /\bbandwidth\b/, /\bprice range\b/, /\bgap (?:up|down)\b/] },
  { category: 'market_cap_style', subcategory: 'size_style', patterns: [/\blarge.?cap\b/, /\bmid.?cap\b/, /\bsmall.?cap\b/, /\bmicro.?cap\b/, /\bnano.?cap\b/, /\bsme\b/, /\bpenny\b/, /\bbluechip\b/, /\btrillionare\b/] },
  { category: 'sector_theme', subcategory: 'sector_or_theme', patterns: [/\bsector\b/, /\bindustr/, /\bgroup compan/, /\bgroup\b/, /\bconglomerate\b/, /\bholding company\b/, /\brevenue exposure\b/, /\bai stocks?\b/, /\bbatter/, /\bev stocks?\b/, /\bgold (?:stocks?|prices?)/, /\bsilver stocks?\b/, /\bmonsoons?\b/, /\bqsr\b/, /\bbank/, /\bnbfc\b/, /\bfinance\b/, /\bit stocks?\b/, /\bit software\b/, /\btechnology\b/, /pharma/, /\bhealthcare\b/, /\bhospitals?\b/, /\bauto\b/, /\bfmcg\b/, /\bconsumer\b/, /\bdefen[cs]e\b/, /infra/, /\brailway\b/, /logistics?/, /\bcement\b/, /chemical/, /fertiliser/, /\bagricultur/, /\bhorticulture\b/, /\blivestock\b/, /\bairlines?\b/, /\bapparels?\b/, /\baquaculture\b/, /\bbeverages?\b/, /\bbuilding materials?\b/, /\bcables?\b/, /\bconstruction\b/, /\bdiversified\b/, /\belectronics?\b/, /\bengineering\b/, /\bfinancial services\b/, /\bgems and jewellery\b/, /\bglass\b/, /\bhardware\b/, /\benabled services\b/, /\binvit\b/, /\birrigation\b/, /\bleather\b/, /\bmedia\b/, /\bpackaging\b/, /\bpaper\b/, /petrochemical/, /\bplastics?\b/, /\breal estate\b/, /\bretail\b/, /\brubber\b/, /\bservices stocks?/, /\bshipping\b/, /\bsugar\b/, /\btea \/ coffee\b/, /\btourism\b/, /\benergy\b/, /\bpower\b/, /\boil\b/, /\bgas\b/, /\bcrude\b/, /metals?/, /\bmining\b/, /\brealty\b/, /\btextile\b/, /telecommunication/, /\bagro\b/, /\beducation\b/, /\btata\b/, /\badani\b/, /\bpsu\b/, /\bbirla\b/, /\bbajaj\b/, /\bhinduja\b/, /\bjindal\b/, /\bmahindra\b/, /\bvedanta\b/, /\bambani\b/, /\breliance\b/, /\bgodrej\b/, /\bmurugappa\b/, /\bpli\b/] },
  { category: 'composite_strategy', subcategory: 'multi_factor_strategy', patterns: [/\bquality\b/, /\bgrowth\b/, /\bgrowers?\b/, /\bsafe\b/, /\bstable\b/, /compounder/, /champion/, /\bleader\b/, /favourites?/, /\bdelight\b/, /\bscore/, /\bchecklist\b/, /\bstrategy\b/, /\bexpert stock screener\b/, /\bportfolio\b/, /\bmultibagger/, /\bwealth creator\b/, /\bmoon\b/, /magic formula/, /\bcanslim\b/, /\bwarren buffet/, /\bcoffecan\b/, /\bbuy & forget\b/, /superstars?/, /classics?/, /money spinners?/, /\btriple (?:dhamaka|trouble)\b/, /double bonanza/, /\bdouble (?:whammy|trouble)\b/, /\bbull cartel\b/, /\bemerging opportunities\b/, /\bready to take off\b/, /\bmonopoly business\b/, /\bpotential multibagger\b/, /\bconsistent high performing\b/, /\bnifty probables\b/, /\bsales decreasing, price increasing\b/] },
];

const bullishPatterns = [
  /\bbull/, /\bbuy\b/, /\bbreakout\b/, /\buptrend\b/, /\btrending up\b/, /\bcrossed above\b/,
  /\babove\b/, /\bgainer/, /\bhigh\b/, /\boversold\b/, /\bpositive\b/, /\brising\b/, /\bincreas/,
  /\boutperform/, /\bgolden cross\b/, /\blong buildup\b/, /\bshort covering\b/, /\bstrong\b/,
];

const bearishPatterns = [
  /\bbear/, /\bsell\b/, /\bbreakdown\b/, /\bdowntrend\b/, /\btrending down\b/, /\bcrossed below\b/,
  /\bbelow\b/, /\bloser/, /\blow\b/, /\boverbought\b/, /\bnegative\b/, /\bfalling\b/, /\bdecreas/,
  /\bunderperform/, /\bdeath cross\b/, /\bshort buildup\b/, /\blong unwinding\b/, /\bweak\b/,
];

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function classify(name: string): Classification {
  const text = name.toLowerCase().replace(/[–—]/g, '-');
  let best: CategoryRule | undefined;
  let bestScore = 0;

  for (const rule of rules) {
    const matches = rule.patterns.filter(pattern => pattern.test(text)).length;
    const score = matches === 0 ? 0 : matches + (rule.weight ?? 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  const category = best?.category ?? 'other';
  const subcategory = best?.subcategory ?? 'uncategorized';
  const bullish = includesAny(text, bullishPatterns);
  const bearish = includesAny(text, bearishPatterns);
  const signal_bias = bullish === bearish ? 'neutral' : bullish ? 'bullish' : 'bearish';

  let investment_horizon: Classification['investment_horizon'] = 'long_term';
  if (/\b(?:5|15|30|45|60)[ -]?min\b|\bintraday\b|\bday trade\b|\bbtst\b|\bstbt\b|\bgap (?:up|down)\b|\bopen(?:ing)?\b/.test(text)) {
    investment_horizon = 'intraday';
  } else if (/\b1h\b|\b2h\b|\b4h\b|\bhour\b|\bdaily\b|\bday\b|\bswing\b|\bweek\b/.test(text) || category.startsWith('technical_') || category === 'volatility') {
    investment_horizon = 'swing';
  } else if (/\bmonth\b|\bquarter\b|\b6 months?\b|\b1 year\b|\b52.?week\b/.test(text)) {
    investment_horizon = 'positional';
  }

  const confidence = best ? Math.min(0.98, 0.66 + Math.min(bestScore, 4) * 0.08) : 0.35;
  return { category, subcategory, signal_bias, investment_horizon, confidence };
}

function quoteCsv(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const db = new Database(dbPath, { readonly: true });
const rows: ScreenerRow[] = [
  ...db.prepare(`SELECT 'trendlyne' AS source, screener_id, screener_name FROM trendlyne_screeners ORDER BY screener_name, screener_id`).all() as ScreenerRow[],
  ...db.prepare(`SELECT 'moneycontrol' AS source, scan_id AS screener_id, screener_name FROM moneycontrol_screeners ORDER BY screener_name, scan_id`).all() as ScreenerRow[],
  ...db.prepare(`SELECT 'etnow' AS source, screener_id, screener_name FROM etnow_screeners ORDER BY screener_name, screener_id`).all() as ScreenerRow[],
];
db.close();

const classifiedRows = rows.map(row => ({ ...row, ...classify(row.screener_name) }));
const header = ['source', 'screener_id', 'screener_name', 'category', 'subcategory', 'signal_bias', 'investment_horizon', 'confidence'];
const csv = [
  header.join(','),
  ...classifiedRows.map(row => header.map(key => quoteCsv(row[key as keyof typeof row])).join(',')),
].join('\n');

fs.writeFileSync(outputPath, `${csv}\n`, 'utf8');

const categoryCounts = classifiedRows.reduce<Record<string, number>>((counts, row) => {
  counts[row.category] = (counts[row.category] ?? 0) + 1;
  return counts;
}, {});

console.log(`Categorized ${classifiedRows.length} screener names to ${outputPath}`);
console.log(categoryCounts);
