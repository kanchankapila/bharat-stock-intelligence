"""
Beta-Bernoulli per-signal-type win probability priors.
Stored as JSON in app_settings key 'signal_type_priors'.
Schema: {"EMA_BULL_STACK": {"alpha": 12.0, "beta": 8.0}, ...}
"""
import json
from db_compat import query_one, execute

PRIOR_ALPHA = 1.0
PRIOR_BETA  = 1.0


def load_priors() -> dict:
    row = query_one("SELECT value FROM app_settings WHERE key='signal_type_priors'", ())
    if row:
        try:
            val = row['value'] if hasattr(row, 'keys') else row[0]
            return json.loads(val)
        except Exception:
            pass
    return {}


def save_priors(priors: dict) -> None:
    execute("""
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('signal_type_priors', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, "updatedAt"=CURRENT_TIMESTAMP
    """, (json.dumps(priors),))


def update_priors_from_outcomes(outcomes_df) -> dict:
    """Update Beta-Bernoulli priors from DataFrame with columns: signals_json, outcome."""
    priors = load_priors()

    for _, row in outcomes_df.iterrows():
        is_win   = str(row.get('outcome', '')) == 'WIN'
        sig_json = row.get('signals_json')
        if not sig_json:
            continue
        try:
            signal_types = [s.get('type', '') for s in json.loads(sig_json) if isinstance(s, dict)]
        except Exception:
            continue
        for stype in signal_types:
            if not stype:
                continue
            if stype not in priors:
                priors[stype] = {'alpha': PRIOR_ALPHA, 'beta': PRIOR_BETA}
            if is_win:
                priors[stype]['alpha'] += 1.0
            else:
                priors[stype]['beta']  += 1.0

    save_priors(priors)
    return priors


def get_posterior_mean(priors: dict, signal_type: str) -> float:
    """Beta posterior mean = alpha / (alpha + beta)."""
    p = priors.get(signal_type, {'alpha': PRIOR_ALPHA, 'beta': PRIOR_BETA})
    return p['alpha'] / (p['alpha'] + p['beta'])


def blend_with_prior(ensemble_prob: float, signal_types: list, priors: dict,
                     prior_weight: float = 0.15) -> float:
    """Blend ensemble probability with average Beta posterior mean across signal types."""
    if not signal_types or not priors:
        return ensemble_prob
    means = [get_posterior_mean(priors, st) for st in signal_types if st]
    if not means:
        return ensemble_prob
    return (1 - prior_weight) * ensemble_prob + prior_weight * (sum(means) / len(means))


if __name__ == '__main__':
    priors = load_priors()
    print(f"Signal type priors ({len(priors)} types):")
    for st, p in sorted(priors.items(),
                        key=lambda x: -x[1]['alpha'] / (x[1]['alpha'] + x[1]['beta'])):
        mean = p['alpha'] / (p['alpha'] + p['beta'])
        n    = p['alpha'] + p['beta'] - PRIOR_ALPHA - PRIOR_BETA
        print(f"  {st:<30} mean={mean:.3f}  obs~{n:.0f}")
