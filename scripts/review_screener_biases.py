"""Review every stored bias and apply an optimistic, transactionally checked repair.

The JSON report preserves the pre-repair labels and the reason for every decision, including
every neutral. It is also the exact application manifest; a changed row aborts the transaction.
No historical memberships, outcomes, predictions or frozen experiments are rewritten.
"""
import argparse
import csv
import hashlib
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/server'))
from db_compat import connect
from screener_semantics import analyze_screener

POLICY_PATH = Path(__file__).resolve().parents[1] / 'src/server/config/screenerSemantics.json'


def risk_analysis(con):
    from unified_ranker import UnifiedRanker, is_red_flagged
    ranker = UnifiedRanker.__new__(UnifiedRanker)
    ranker.conn = con
    ranker._degraded_count = 0
    membership = ranker._get_screener_membership()
    lost = []
    causes = Counter()
    classes = {r['symbol']: r['classification'] for r in con.execute(
        'SELECT symbol,classification FROM unified_recommendations '
        'WHERE generated_at=(SELECT MAX(generated_at) FROM unified_recommendations)').fetchall()}
    for symbol, entries in membership.items():
        if not is_red_flagged(entries):
            continue
        candidate = [{**e, 'signal_bias': analyze_screener(e['screener_name'], e.get('source', ''), e.get('screener_id', ''))['semantic_bias']} for e in entries]
        if not is_red_flagged(candidate):
            lost.append({'symbol': symbol, 'classification': classes.get(symbol)})
            causes.update({e['screener_name'] for e in entries if e['category'] == 'risk_red_flags' and e['signal_bias'] == 'bearish'})
    return {'veto_removals': len(lost), 'affected': lost, 'causes': dict(causes)}

TARGETS = (
    ('screener_master', 'scan_id', 'name', 'inferred_sentiment', True),
    ('screener_catalog', 'screener_id', 'screener_name', 'signal_bias', True),
    ('trendlyne_screeners', 'screener_id', 'screener_name', 'sentiment', False),
)


def review(con):
    decisions = []
    for table, key, name, bias, sourced in TARGETS:
        source = 'source' if sourced else "'trendlyne' AS source"
        for row in con.execute(f'SELECT {key} AS id, {source}, {name} AS name, {bias} AS bias FROM {table}').fetchall():
            decisions.append({'table': table, **dict(row), **analyze_screener(row['name'], row['source'], row['id'])})
    return sorted(decisions, key=lambda r: (r['table'], r['source'], r['id']))


def definitions(con):
    result = {}
    for r in con.execute('SELECT screener_id,query_text FROM trendlyne_screeners').fetchall():
        result[('trendlyne', str(r['screener_id']))] = r['query_text'] or ''
    for r in con.execute('SELECT screener_id,query_condition FROM etnow_screeners').fetchall():
        value = r['query_condition'] or ''
        for _ in range(3):
            try:
                decoded = json.loads(value)
            except (ValueError, TypeError):
                break
            if isinstance(decoded, dict):
                value = decoded.get('queryCondition', '')
                break
            value = decoded
        result[('etnow', str(r['screener_id']))] = str(value)
    for r in con.execute('SELECT screener_key,first_operand,operation_type,second_operand,api_type FROM et_marketstats_screeners').fetchall():
        result[('et_marketstats', str(r['screener_key']))] = ' '.join(str(r[k]) for k in ('first_operand', 'operation_type', 'second_operand') if r[k]) or r['api_type'] or ''
    return result


def summary(rows):
    return {
        'rows': len(rows),
        'changes': sum(r['bias'] != r['semantic_bias'] for r in rows),
        'previous_neutrals': sum(r['bias'] is None or r['bias'].lower() == 'neutral' for r in rows),
        'biases': dict(Counter(r['semantic_bias'] for r in rows)),
        'roles': dict(Counter(r['role'] for r in rows)),
        'transitions': dict(Counter(f"{r['bias']}->{r['semantic_bias']}" for r in rows)),
    }


def apply_review(con, rows):
    risks = risk_analysis(con)
    if risks['veto_removals']:
        raise RuntimeError(f"Refusing to remove {risks['veto_removals']} existing risk vetoes; a separate measured risk-veto experiment is required.")
    current = review(con)
    if current != rows:
        raise RuntimeError('Catalog changed since review; generate and inspect a fresh manifest.')
    changed = 0
    for table, key, name, bias, sourced in TARGETS:
        for row in rows:
            if row['table'] != table or row['bias'] == row['semantic_bias']:
                continue
            predicate = f'{key} = ? AND {bias} IS NOT DISTINCT FROM ?'
            params = [row['semantic_bias'], row['id'], row['bias']]
            if sourced:
                predicate += ' AND source = ?'
                params.append(row['source'])
            result = con.execute(f'UPDATE {table} SET {bias} = ? WHERE {predicate}', params)
            if result.rowcount != 1:
                raise RuntimeError(f'Concurrent repair of {table}/{row["id"]}; rolling back.')
            changed += 1
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--evidence', type=Path, help='Paired replay JSON required before applying scoring-input labels.')
    parser.add_argument('--csv', type=Path)
    args = parser.parse_args()
    if not args.apply and (args.report.exists() or (args.csv and args.csv.exists())):
        raise RuntimeError('Review artifacts are immutable; use a new versioned output path.')
    con = connect()
    try:
        if args.apply:
            if not args.evidence:
                raise RuntimeError('--apply requires --evidence from measure_screener_semantic_repair.py')
            evidence = json.loads(args.evidence.read_text(encoding='utf-8'))
            if evidence.get('graded_dates', 0) < 20 or evidence.get('verdict') != 'PROMOTION-PASS':
                raise RuntimeError('Insufficient promotion evidence; labels remain unapplied (20 graded dates and PROMOTION-PASS required).')
            report = json.loads(args.report.read_text(encoding='utf-8'))
            if report['policy_sha256'] != hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest():
                raise RuntimeError('Policy changed since review; refusing an unfrozen application.')
            if evidence.get('manifest_sha256') != hashlib.sha256(args.report.read_bytes()).hexdigest():
                raise RuntimeError('Replay did not grade this exact frozen manifest.')
            changed = apply_review(con, report['decisions'])
            con.commit()
            print(json.dumps({'applied': changed, 'remaining_changes': summary(review(con))['changes']}))
        else:
            con.execute('SET TRANSACTION READ ONLY')
            rows = review(con)
            report = {'reviewed_at': datetime.now(timezone.utc).isoformat(),
                      'policy_sha256': hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest(),
                      'risk_analysis': risk_analysis(con),
                      'summary': {table: summary([r for r in rows if r['table'] == table]) for table, *_ in TARGETS},
                      'decisions': rows}
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
            if args.csv:
                criteria = definitions(con)
                args.csv.parent.mkdir(parents=True, exist_ok=True)
                fields = ['table', 'source', 'id', 'name', 'bias', 'semantic_bias', 'role', 'rule',
                          'reason', 'semantic_basis', 'empirical_direction', 'criteria']
                with args.csv.open('w', newline='', encoding='utf-8') as stream:
                    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
                    writer.writeheader()
                    for row in rows:
                        writer.writerow({**row, 'criteria': criteria.get((row['source'].lower(), str(row['id'])), '')})
            print(json.dumps(report['summary'], indent=2))
            print(json.dumps(report['risk_analysis'], indent=2))
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == '__main__':
    main()
