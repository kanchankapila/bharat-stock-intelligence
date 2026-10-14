"""Walk-forward training, honest evaluation, final fit, calibration, registration.

The CV report is computed from walk-forward OUT-OF-FOLD predictions only, through the same
harness (evaluation.metrics / evaluation.backtest) the live ledger is graded with. The model's
self-reported fit is never stored as its accuracy.
"""
from __future__ import annotations

import hashlib
import json
import platform
from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg
import sklearn
from psycopg.types.json import Jsonb
from sklearn.isotonic import IsotonicRegression

from bharat_alpha.config import get_settings
from bharat_alpha.db import jsonable
from bharat_alpha.evaluation.backtest import run_backtest
from bharat_alpha.evaluation.metrics import evaluate_scores, per_date_ic
from bharat_alpha.features import FEATURE_SET_VERSION
from bharat_alpha.modeling.cv import walk_forward_folds
from bharat_alpha.modeling.dataset import Dataset
from bharat_alpha.modeling.members import combine, default_members

LABEL_NAME = "fwd_open_to_open_rankgauss"
BENCHMARK_FACTOR = "mom_12_1"            # legacy's only near-survivor among price factors
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def resolve_artifact_path(path: str | Path) -> Path:
    """Make artifact paths independent of the worker's launch directory.

    Historical rows store paths relative to the repository root.  Resolving them against the
    process CWD made an otherwise valid promoted model unloadable when the CLI, scheduler or a
    service was launched from a subdirectory.
    """
    artifact = Path(path)
    return artifact if artifact.is_absolute() else REPOSITORY_ROOT / artifact


def artifact_runtime() -> dict[str, str]:
    """Versions that determine whether a persisted sklearn estimator is safe to load."""
    return {
        "python": platform.python_version(),
        "sklearn": sklearn.__version__,
        "numpy": np.__version__,
        "joblib": joblib.__version__,
    }


def artifact_runtime_tag(runtime: dict[str, str] | None = None) -> str:
    """Short ID suffix so a compatible rebuild cannot collide with an old artifact row."""
    payload = json.dumps(runtime or artifact_runtime(), sort_keys=True).encode()
    return hashlib.sha1(payload).hexdigest()[:8]


def dump_bundle(bundle: "ModelBundle", path: Path) -> None:
    """Persist an estimator and its pre-unpickle compatibility manifest."""
    runtime = artifact_runtime()
    bundle.artifact_runtime = runtime
    joblib.dump(bundle, path)
    sidecar = path.with_suffix(path.suffix + ".runtime.json")
    temporary = sidecar.with_suffix(sidecar.suffix + ".tmp")
    temporary.write_text(json.dumps(runtime, sort_keys=True), encoding="utf-8")
    temporary.replace(sidecar)


def _wide(s: pd.Series) -> pd.DataFrame:
    return s.unstack("instrument_id")


@dataclass
class ModelBundle:
    """Everything needed to score a new date, pickled as one artifact."""
    horizon: int
    feature_cols: list[str]
    members: list
    weights: dict[str, float]
    calib_excess: IsotonicRegression
    calib_prob: IsotonicRegression
    abs_residuals: np.ndarray            # OOF |excess - pred_excess|, for conformal intervals
    feature_means: dict[str, float] = field(default_factory=dict)
    feature_sds: dict[str, float] = field(default_factory=dict)
    artifact_runtime: dict[str, str] = field(default_factory=artifact_runtime)

    def member_scores(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X.reindex(columns=self.feature_cols)
        return pd.DataFrame({m.name: m.predict(X) for m in self.members}, index=X.index)

    def score(self, X: pd.DataFrame, weights: dict[str, float] | None = None) -> pd.DataFrame:
        ms = self.member_scores(X)
        ens = combine(ms, weights or self.weights)
        rank_pct = ens.groupby(level="date").rank(pct=True)
        out = pd.DataFrame({"score": ens, "rank_pct": rank_pct})
        out["pred_excess"] = self.calib_excess.predict(rank_pct.to_numpy())
        out["prob_outperform"] = self.calib_prob.predict(rank_pct.to_numpy())
        return out.join(ms)

    def interval(self, alpha: float) -> float:
        q = min(max(1 - alpha, 0.0), 1.0)
        return float(np.quantile(self.abs_residuals, q, method="higher")) if len(self.abs_residuals) else float("nan")


def walk_forward_oof(ds: Dataset, members_factory, n_folds: int, min_train: int) -> pd.DataFrame:
    folds = walk_forward_folds(ds.dates, n_folds, ds.horizon, min_train)
    d = ds.X.index.get_level_values("date")
    parts = []
    for f in folds:
        tr, te = d.isin(f.train), d.isin(f.test)
        Xtr, ytr = ds.X[tr], ds.y[tr]
        ms = {}
        for m in members_factory():
            m.fit(Xtr, ytr, ds.horizon)
            ms[m.name] = m.predict(ds.X[te])
        parts.append(pd.DataFrame(ms, index=ds.X.index[te]))
    return pd.concat(parts).sort_index()


def evaluate_oof(ds: Dataset, oof: pd.DataFrame, weights: dict[str, float]) -> dict:
    s = get_settings()
    ens = combine(oof, weights)
    fwd = _wide(ds.fwd.reindex(oof.index))
    report = {"members": {}, "horizon": ds.horizon}
    for col in oof.columns:
        report["members"][col] = evaluate_scores(_wide(oof[col]), fwd, ds.horizon, s.top_k, s.min_effective_dates)
    report["ensemble"] = evaluate_scores(_wide(ens), fwd, ds.horizon, s.top_k, s.min_effective_dates)
    uni = ds.features.universe
    anchor = oof.index.get_level_values("date").min()
    bt = run_backtest(_wide(ens), ds.panel, uni, ds.horizon, s.top_k, s.hold_buffer_mult,
                      max_participation=s.max_participation, anchor=anchor)
    report["backtest"] = bt.summary()
    report["backtest_periods"] = {str(k.date()): round(float(v), 6) for k, v in bt.periods["net_excess"].items()} \
        if not bt.periods.empty else {}
    if BENCHMARK_FACTOR in ds.X.columns:
        b = ds.X.loc[oof.index, BENCHMARK_FACTOR]
        bbt = run_backtest(_wide(b), ds.panel, uni, ds.horizon, s.top_k, s.hold_buffer_mult,
                           max_participation=s.max_participation, anchor=anchor)
        report["benchmark"] = {"factor": BENCHMARK_FACTOR,
                               "ic": evaluate_scores(_wide(b), fwd, ds.horizon, s.top_k, s.min_effective_dates),
                               "backtest": bbt.summary(),
                               "backtest_periods": {str(k.date()): round(float(v), 6)
                                                    for k, v in bbt.periods["net_excess"].items()} if not bbt.periods.empty else {}}
    # leak tell: a score that tracks the SAME-day return it was computed after is suspicious
    same_day = (ds.panel.close / ds.panel.close.shift(1) - 1)
    report["corr_score_same_day_return"] = float(per_date_ic(_wide(ens), same_day).mean())
    report["oof_dates"] = [str(oof.index.get_level_values("date").min().date()),
                           str(oof.index.get_level_values("date").max().date())]
    return report


def _calibrate(ds: Dataset, oof: pd.DataFrame, weights: dict[str, float]):
    ens = combine(oof, weights)
    rank_pct = ens.groupby(level="date").rank(pct=True)
    exc = ds.excess.reindex(oof.index)
    ok = exc.notna()
    ce = IsotonicRegression(out_of_bounds="clip").fit(rank_pct[ok], exc[ok])
    cp = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(rank_pct[ok], (exc[ok] > 0).astype(float))
    resid = np.abs(exc[ok].to_numpy() - ce.predict(rank_pct[ok].to_numpy()))
    rng = np.random.default_rng(0)
    if len(resid) > 50_000:
        resid = rng.choice(resid, 50_000, replace=False)
    return ce, cp, np.sort(resid)


def config_hash(members: list, feature_cols: list[str]) -> str:
    desc = [(m.name, getattr(m, "params", {}), getattr(m, "alpha", None), getattr(m, "seeds", None)) for m in members]
    return hashlib.sha1(json.dumps([desc, sorted(feature_cols), FEATURE_SET_VERSION], default=str).encode()).hexdigest()[:10]


@dataclass
class TrainResult:
    model_id: str
    report: dict
    bundle: ModelBundle
    oof: pd.DataFrame


def train_model(conn: psycopg.Connection, ds: Dataset, members_factory=None, register: bool = True) -> TrainResult:
    s = get_settings()
    members_factory = members_factory or (lambda: default_members(s.seeds))
    uniform = {m.name: 1.0 for m in members_factory()}
    oof = walk_forward_oof(ds, members_factory, s.cv_folds, s.train_min_dates)
    report = evaluate_oof(ds, oof, uniform)
    final = members_factory()
    for m in final:
        m.fit(ds.X, ds.y, ds.horizon)
    ce, cp, resid = _calibrate(ds, oof, uniform)
    bundle = ModelBundle(ds.horizon, list(ds.X.columns), final, uniform, ce, cp, resid,
                         ds.X.mean().to_dict(), ds.X.std().to_dict())
    chash = config_hash(final, list(ds.X.columns))
    end = ds.dates.max().date()
    runtime = artifact_runtime()
    model_id = f"h{ds.horizon}-{end:%Y%m%d}-{chash}-{artifact_runtime_tag(runtime)}"
    report["config_hash"] = chash
    report["artifact_runtime"] = runtime
    report["n_rows"] = int(len(ds.X))
    report["features"] = list(ds.X.columns)
    recent = ds.X.index.get_level_values("date") >= ds.dates[max(len(ds.dates) - 60, 0)]
    report["feature_coverage"] = {c: float(v) for c, v in ds.X[recent].notna().mean().items()}
    if register:
        path = resolve_artifact_path(Path(s.artifacts_dir) / "models" / f"{model_id}.joblib")
        path.parent.mkdir(parents=True, exist_ok=True)
        dump_bundle(bundle, path)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO alpha.model(model_id, horizon, feature_set, label, params, train_start, train_end,
                                        cv_report, status, artifact_path)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'candidate',%s)
                ON CONFLICT (model_id) DO NOTHING""",
                (model_id, ds.horizon, FEATURE_SET_VERSION, LABEL_NAME,
                 Jsonb({"config_hash": chash, "artifact_runtime": runtime}),
                 ds.dates.min().date(), end, Jsonb(jsonable(report)), str(path)))
        conn.commit()
    return TrainResult(model_id, report, bundle, oof)


def load_bundle(path: str) -> ModelBundle:
    artifact = resolve_artifact_path(path)
    sidecar = artifact.with_suffix(artifact.suffix + ".runtime.json")
    if not sidecar.exists():
        raise RuntimeError(
            f"model artifact {artifact.name} has no runtime manifest; retrain it before serving"
        )
    recorded = json.loads(sidecar.read_text(encoding="utf-8"))
    current = artifact_runtime()
    if recorded.get("sklearn") != current["sklearn"]:
        raise RuntimeError(
            f"model artifact {artifact.name} requires scikit-learn {recorded.get('sklearn')}; "
            f"runtime is {current['sklearn']}; retrain through the promotion gate"
        )
    bundle = joblib.load(artifact)
    embedded = getattr(bundle, "artifact_runtime", None)
    if embedded != recorded:
        raise RuntimeError(f"model artifact {artifact.name} runtime manifest does not match its payload")
    return bundle

