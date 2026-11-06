"""Shared semantic policy. Empirical direction requires a separate, dated evaluation."""
import json
import re
from pathlib import Path

_POLICY = json.loads((Path(__file__).parent / 'config/screenerSemantics.json').read_text(encoding='utf-8'))
_RULES = [(rule, re.compile(rule['pattern'])) for rule in _POLICY['rules']]
_DESCRIPTION = re.compile(r'(?<!^)(?:Identif(?:ies|y)|Highlights|Focuses|Discover|Targets|Selects|Screens|List of|Stocks which|Stocks where)')


def screener_title(name: str) -> str:
    title = _DESCRIPTION.split(name or '', maxsplit=1)[0].strip()
    return re.sub(r'\s+', ' ', title.lower().replace('–', '-').replace('—', '-'))


def analyze_screener(name: str, source: str = '', screener_id: str = '') -> dict:
    title = screener_title(name)
    both = re.search(r'\bbullish\b', title) and re.search(r'\bbearish\b', title)
    for rule, pattern in _RULES:
        if rule.get('source') and rule['source'] != (source or '').lower():
            continue
        if rule.get('ids') and str(screener_id) not in rule['ids']:
            continue
        if not both and pattern.search(title):
            return {'semantic_bias': rule['bias'], 'role': rule['role'], 'rule': rule['id'],
                    'reason': rule['reason'], 'empirical_direction': 'unproven',
                    'semantic_basis': 'verified_filter' if rule.get('source') else 'screen_title', 'policy_version': _POLICY['version']}
    return {'semantic_bias': 'neutral', 'role': 'unresolved', 'rule': 'abstain',
            'reason': 'The name does not specify one unambiguous directional condition.',
            'empirical_direction': 'unproven', 'semantic_basis': 'screen_title', 'policy_version': _POLICY['version']}


def membership_key(source: str, name: str, screener_id: str = '') -> tuple:
    return ((source or '').lower(), re.sub(r'[^a-z0-9]+', ' ', screener_title(name)).strip() or str(screener_id))


def deduplicate_membership(membership: dict) -> dict:
    result = {}
    for symbol, entries in membership.items():
        seen = {}
        for entry in entries:
            if analyze_screener(entry.get('screener_name', ''), entry.get('source', ''), entry.get('screener_id', ''))['role'] == 'invalid_filter':
                continue
            key = membership_key(entry.get('source', ''), entry.get('screener_name', ''), entry.get('screener_id', ''))
            if key not in seen:
                seen[key] = entry
        result[symbol] = list(seen.values())
    return result
