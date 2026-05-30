import db from './db';

export type ScreenerCategory =
  | 'technical_trend' | 'technical_reversal' | 'technical_breakout' | 'technical_momentum'
  | 'fundamental_quality' | 'fundamental_growth'
  | 'valuation' | 'ownership_institutional' | 'sector_theme' | 'composite_strategy'
  | 'income_dividend' | 'event_corporate_action' | 'risk_red_flags'
  | 'analyst_sentiment' | 'volume_liquidity' | 'volatility'
  | 'market_cap_style' | 'derivatives_positioning' | 'other';

export type SignalBias = 'bullish' | 'bearish' | 'neutral';
export type InvestmentHorizon = 'intraday' | 'swing' | 'positional' | 'long_term';

export interface ClassifyResult {
  category: ScreenerCategory;
  subcategory: string;
  signal_bias: SignalBias;
  investment_horizon: InvestmentHorizon;
  confidence: number;
  classified_by: 'keyword';
}

// ── Rule table (mirrors categorizeScreenerNames.ts) ──────────────────────────

interface CategoryRule {
  category: ScreenerCategory;
  subcategory: string;
  patterns: RegExp[];
  weight?: number;
}

const RULES: CategoryRule[] = [
  { category: 'derivatives_positioning', subcategory: 'open_interest', patterns: [/\bopen interest\b/, /\boi\b/, /\blong buildup\b/, /\blong build-up\b/, /\bshort buildup\b/, /\bshort build-up\b/, /\bshort covering\b/, /\blong unwinding\b/, /\bpcr\b/, /\bput.?call\b/, /\bfno\b/, /\bfutures and options\b/, /\btrade ban\b/] },
  { category: 'ownership_institutional', subcategory: 'institutional_activity', patterns: [/\bfii?s?\b/, /\bfpi\b/, /\bdiis?\b/, /\bmutual fund/, /\bmfs?\b/, /\binstitution/, /\bforeign investor/, /\bsuperstar investor/, /\binsider/, /\bpromoter (?:buy|sell|increas|decreas|holding|stake|pledge)/, /\bshareholding/, /\bpublic holding\b/] },
  { category: 'ownership_institutional', subcategory: 'bulk_block_deals', patterns: [/\bbulk deal/, /\bblock deal/] },
  { category: 'analyst_sentiment', subcategory: 'broker_forecast', patterns: [/\bbrokers?\b/, /\bforecaster\b/, /\banalysts?\b/, /\btarget price\b/, /\bconsensus\b/, /\bstreet favorite\b/, /\breco\b/] },
  { category: 'event_corporate_action', subcategory: 'corporate_action', patterns: [/\bbonus\b/, /\bsplit\b/, /\bbuyback\b/, /\bright issue\b/, /\bdividend announcement\b/, /\bboard meeting\b/] },
  { category: 'event_corporate_action', subcategory: 'earnings_event', patterns: [/\bresult/, /\bsurprise\b/, /\bupcoming dividends?\b/] },
  { category: 'income_dividend', subcategory: 'dividend_income', patterns: [/\bdividend\b/, /\byield stocks?\b/] },
  { category: 'risk_red_flags', subcategory: 'financial_or_governance_risk', patterns: [/\bred flag/, /\bwealth destroy/, /\bvalue trap/, /\bmomentum trap/, /\bavoid\b/, /\bcaution\b/, /\bpledge/, /\bdeclining profit/, /\bdecreasing (?:eps|revenue|sales|profit|roe|roce)/, /\bincreasing debt/, /\bweak fundamental/, /\bpoor cash/, /\bloss(?:es| making)/, /\bprofit to loss\b/, /\bhigh debt/, /\bhigh leverage\b/, /\bdebt load\b/, /\bnpa\b/, /\bprovisions?\b/] },
  { category: 'fundamental_quality', subcategory: 'balance_sheet_quality', patterns: [/\bzero debt\b/, /\bno debt\b/, /\bdebt.?free\b/, /\blow debt\b/, /\bdecreasing debt\b/, /\bdebt reduction\b/, /\blow leverage\b/, /\bcash rich\b/, /\bcash cow/, /\bcash king/, /\bpositive cash flow\b/, /\bfree cash flow\b/, /\bpiotroski\b/, /\bfinancial health\b/, /\bgood financials\b/, /\bbalance sheet\b/] },
  { category: 'fundamental_quality', subcategory: 'capital_efficiency', patterns: [/\broe\b/, /\broce\b/, /\broa\b/, /\breturn on (?:equity|capital|assets)/, /\bprofit margins?\b/, /\bmargin expansion\b/, /\bmargin king/] },
  { category: 'fundamental_growth', subcategory: 'earnings_growth', patterns: [/\bprofit growth\b/, /\beps growth\b/, /\bearnings growth\b/, /\bprofit increas/, /\brising profit/, /\bprofit acceleration\b/] },
  { category: 'fundamental_growth', subcategory: 'revenue_growth', patterns: [/\bsales growth\b/, /\brevenue growth\b/, /\btop.?line growth\b/, /\brising revenue\b/, /\brising sales\b/, /\bsales increas/] },
  { category: 'valuation', subcategory: 'relative_or_absolute_value', patterns: [/\bvalue stocks?\b/, /\bvaluation/, /\bundervalu/, /\bovervalu/, /\bbargain/, /\bmargin of safety\b/, /\blow pe\b/, /\bhigh pe\b/, /\bpe (?:ratio|century|buy zone|sell zone)\b/, /\bp\/e\b/, /\bprice.?to.?earnings\b/, /\bpeg\b/, /\blow pb\b/, /\bhigh pb\b/, /\bp\/b\b/, /\bprice.?to.?book\b/, /\bbook value\b/, /\bintrinsic value\b/, /\bgraham\b/, /\bdvm\b/] },
  { category: 'technical_reversal', subcategory: 'candlestick_reversal', patterns: [/\breversal\b/, /\bcontinuation\b/, /\bengulfing\b/, /\bhammer\b/, /\bdoji\b/, /\bharami\b/, /\bmarubozu\b/, /\bmorning star\b/, /\bevening star\b/, /\bshooting star\b/, /\bcandlestick\b/] },
  { category: 'technical_reversal', subcategory: 'oscillator_reversal', patterns: [/\boversold\b/, /\boverbought\b/, /\bdivergence\b/, /\brsi reversal\b/, /\bbounce\b/, /\bturnaround\b/, /buy on dips/, /\bcontrarian\b/] },
  { category: 'technical_breakout', subcategory: 'price_breakout', patterns: [/\bbreakout/, /\bbreak out\b/, /\bbreakdown/, /\bbreak down\b/, /\bresistance\b/, /\bsupport\b/, /\bpivot\b/, /\btriangle\b/, /\bsqueeze\b/, /\bconsolidation\b/, /\bdarvas\b/, /\bbtst\b/, /\bstbt\b/, /\bperfect buy\b/, /\bperfect sell\b/] },
  { category: 'technical_momentum', subcategory: 'relative_strength', patterns: [/\brelative (?:outperformance|underperformance|strength)\b/, /\boutperform/, /\bunderperform/, /\bmomentum\b/, /\bmultibagger breakout\b/] },
  { category: 'technical_momentum', subcategory: 'price_leadership', patterns: [/\bstrong stocks?\b/, /\bweak stocks?\b/, /\bgainer/, /\bloser/, /\bnew highs?\b/, /\b52.?week (?:high|low)\b/, /\bupper circuit\b/, /\blower circuit\b/] },
  { category: 'technical_trend', subcategory: 'moving_average_trend', patterns: [/\bema\d*/, /\bsma\d*/, /\bmoving average\b/, /\bgolden cross\b/, /\bdeath cross\b/, /\bma crossover\b/] },
  { category: 'technical_trend', subcategory: 'trend_indicator', patterns: [/\badx\b/, /\bsupertrend\b/, /\btrend(?:ing)? (?:up|down)\b/, /\buptrend\b/, /\bdowntrend\b/, /\bbullish trend\b/, /\bbearish trend\b/, /\bmacd\b/, /\bichimoku\b/] },
  { category: 'technical_reversal', subcategory: 'oscillator_signal', patterns: [/\brsi\b/, /\bmfi\b/, /\bcci\b/, /\bstoch/, /\bwilliams %?r\b/, /\brelative strength index\b/] },
  { category: 'volume_liquidity', subcategory: 'volume_delivery', patterns: [/\bvolumes?\b/, /\bdelivery\b/, /\bturnover\b/, /\bliquidity\b/, /\bmost active\b/] },
  { category: 'volatility', subcategory: 'volatility_range', patterns: [/\bvolatility\b/, /\batr\b/, /\bbollinger\b/, /\bbandwidth\b/, /\bprice range\b/, /\bgap (?:up|down)\b/] },
  { category: 'market_cap_style', subcategory: 'size_style', patterns: [/\blarge.?cap\b/, /\bmid.?cap\b/, /\bsmall.?cap\b/, /\bmicro.?cap\b/, /\bpenny\b/, /\bbluechip\b/] },
  { category: 'sector_theme', subcategory: 'sector_or_theme', patterns: [/\bsector\b/, /\bindustr/, /\bbank/, /\bnbfc\b/, /pharma/, /\bhealthcare\b/, /\bauto\b/, /\bfmcg\b/, /\bdefen[cs]e\b/, /infra/, /\brailway\b/, /\bcement\b/, /chemical/, /\benergy\b/, /\bpower\b/, /metals?/, /\breal estate\b/, /\bai stocks?\b/, /\bev stocks?\b/, /\btata\b/, /\badani\b/, /\bpsu\b/, /\bit stocks?\b/, /\btechnology\b/] },
  { category: 'composite_strategy', subcategory: 'multi_factor_strategy', patterns: [/compounder/, /champion/, /\bleader\b/, /\bscore/, /\bchecklist\b/, /\bstrategy\b/, /\bmultibagger/, /\bwealth creator\b/, /magic formula/, /\bcanslim\b/, /\bwarren buffet/, /\bportfolio\b/, /superstars?/] },
];

const BULLISH_PATTERNS = [
  /\bbull/, /\bbuy\b/, /\bbreakout\b/, /\buptrend\b/, /\btrending up\b/, /\bcrossed above\b/,
  /\babove\b/, /\bgainer/, /\bhigh\b/, /\boversold\b/, /\bpositive\b/, /\brising\b/, /\bincreas/,
  /\boutperform/, /\bgolden cross\b/, /\blong buildup\b/, /\bshort covering\b/, /\bstrong\b/,
];

const BEARISH_PATTERNS = [
  /\bbear/, /\bsell\b/, /\bbreakdown\b/, /\bdowntrend\b/, /\btrending down\b/, /\bcrossed below\b/,
  /\bbelow\b/, /\bloser/, /\blow\b/, /\boverbought\b/, /\bnegative\b/, /\bfalling\b/, /\bdecreas/,
  /\bunderperform/, /\bdeath cross\b/, /\bshort buildup\b/, /\blong unwinding\b/, /\bweak\b/,
];

// ── Core classifier ──────────────────────────────────────────────────────────

export function classifyByKeyword(name: string): ClassifyResult {
  const text = name.toLowerCase().replace(/[–—]/g, '-');

  let best: CategoryRule | undefined;
  let bestScore = 0;

  for (const rule of RULES) {
    const matches = rule.patterns.filter(p => p.test(text)).length;
    const score = matches === 0 ? 0 : matches + (rule.weight ?? 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  const bullish = BULLISH_PATTERNS.some(p => p.test(text));
  const bearish = BEARISH_PATTERNS.some(p => p.test(text));
  const signal_bias: SignalBias = bullish === bearish ? 'neutral' : bullish ? 'bullish' : 'bearish';

  let investment_horizon: InvestmentHorizon = 'long_term';
  if (/\b(?:5|15|30|45|60)[ -]?min\b|\bintraday\b|\bday trade\b|\bbtst\b|\bstbt\b|\bgap (?:up|down)\b/.test(text)) {
    investment_horizon = 'intraday';
  } else if (/\b1h\b|\b2h\b|\b4h\b|\bhour\b|\bdaily\b|\bday\b|\bswing\b|\bweek\b/.test(text) || (best?.category ?? '').startsWith('technical_') || best?.category === 'volatility') {
    investment_horizon = 'swing';
  } else if (/\bmonth\b|\bquarter\b|\b6 months?\b|\b1 year\b|\b52.?week\b/.test(text)) {
    investment_horizon = 'positional';
  }

  const confidence = best ? Math.min(0.98, 0.66 + Math.min(bestScore, 4) * 0.08) : 0.35;

  return {
    category: best?.category ?? 'other',
    subcategory: best?.subcategory ?? 'uncategorized',
    signal_bias,
    investment_horizon,
    confidence,
    classified_by: 'keyword',
  };
}

// ── DB update (runs on new screeners only) ───────────────────────────────────

export async function classifyAllScreeners(): Promise<{
  classified: number;
  remaining_other: number;
}> {
  const rows = db.prepare(`
    SELECT scan_id, name FROM screener_master
    WHERE subcategory IS NULL OR classified_by IS NULL
    ORDER BY name
  `).all() as Array<{ scan_id: string; name: string }>;

  if (rows.length === 0) {
    console.log('[Classifier] All screeners already classified.');
    return { classified: 0, remaining_other: 0 };
  }

  console.log(`[Classifier] Classifying ${rows.length} screeners...`);

  const stmt = db.prepare(`
    UPDATE screener_master
    SET subcategory = ?, inferred_category = ?, inferred_sentiment = ?,
        inferred_timeframe = ?, category_confidence = ?, classified_by = ?
    WHERE scan_id = ?
  `);

  let classified = 0;
  let remaining_other = 0;

  for (const row of rows) {
    const r = classifyByKeyword(row.name);
    const timeframe = r.investment_horizon === 'intraday' ? 'intraday' : 'long_term';
    stmt.run(r.subcategory, r.category, r.signal_bias, timeframe, r.confidence, 'keyword', row.scan_id);
    if (r.category === 'other') remaining_other++;
    else classified++;
  }

  console.log(`[Classifier] Done: ${classified} classified, ${remaining_other} remain 'other'`);
  return { classified, remaining_other };
}
