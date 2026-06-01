// Screener configuration scaffold
// Map screener_id (or scan_id) -> configuration used by scoring pipelines.
// Fields: default_timeframe, weight_prior (per domain), min_adv, min_mktcap, default_holding_days, notes

export const SCREENER_CONFIGS: Record<string, any> = {
  // Example entry:
  // 'MC_146': {
  //   default_timeframe: 'short',
  //   weight_prior: { momentum: 0.4, technical: 0.3, fundamental: 0.1, volume: 0.2 },
  //   min_adv: 100000, // minimum average daily volume
  //   min_mktcap: 500e6,
  //   default_holding_days: 7,
  //   notes: 'MoneyControl proscanner 146 - large-cap fundamental picks'
  // }
};

export default SCREENER_CONFIGS;
