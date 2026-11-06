import policy from './config/screenerSemantics.json';

export type SemanticBias = 'bullish' | 'bearish' | 'neutral';
const rules = policy.rules.map(rule => ({ ...rule, pattern: new RegExp(rule.pattern) }));

export function screenerTitle(name: string): string {
  return (name || '').split(/(?<!^)(?:Identif(?:ies|y)|Highlights|Focuses|Discover|Targets|Selects|Screens|List of|Stocks which|Stocks where)/, 1)[0]
    .trim().toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
}

export function analyzeScreener(name: string, source = '', id = '') {
  const title = screenerTitle(name);
  const both = /\bbullish\b/.test(title) && /\bbearish\b/.test(title);
  const rule = both ? undefined : rules.find(rule => (!rule.source || rule.source === source.toLowerCase())
    && (!rule.ids || rule.ids.includes(id)) && rule.pattern.test(title));
  return {
    semantic_bias: (rule?.bias ?? 'neutral') as SemanticBias,
    role: rule?.role ?? 'unresolved',
    rule: rule?.id ?? 'abstain',
    reason: rule?.reason ?? 'The name does not specify one unambiguous directional condition.',
    empirical_direction: 'unproven' as const,
    semantic_basis: rule?.source ? 'verified_filter' : 'screen_title',
    policy_version: policy.version,
  };
}

export function screenerMembershipKey(source: string, name: string, id = ''): string {
  return `${source.toLowerCase()}::${screenerTitle(name).replace(/[^a-z0-9]+/g, ' ').trim() || id}`;
}
