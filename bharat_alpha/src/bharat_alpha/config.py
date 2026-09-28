"""Runtime configuration.

Every knob that changes a measured number lives here, with its unit in the name, so a
threshold is never silently re-tuned by an upstream change (old repo: a hardcoded
FULL_ENGINE_COVERAGE=5 cut 90% of positions by 10% when an engine was paused).

There is exactly one database. A missing DSN is a hard error, never a fallback.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BQA_", env_file=".env", extra="ignore")

    database_url: str = Field(..., description="postgresql://… — required, no default")
    artifacts_dir: Path = Path("./artifacts")

    # Universe (applied per date, computed with no look-ahead)
    min_adt_inr: float = 1e7            # ₹1 crore trailing-20d average daily turnover
    min_price_inr: float = 10.0
    min_history_days: int = 60
    equity_series: tuple[str, ...] = ("EQ", "BE", "BZ")

    # Labels / horizons (trading days)
    horizons: tuple[int, ...] = (5, 21)
    primary_horizon: int = 21
    winsor_pct: float = 0.01

    # Portfolio / costs
    top_k: int = 30
    hold_buffer_mult: float = 2.0       # keep a holding until it drops out of top_k*mult
    max_participation: float = 0.02     # of ADT, for capacity estimates

    # Evaluation reliability
    min_effective_dates: float = 20.0   # dates / horizon, overlap-corrected
    promotion_min_t: float = 2.0
    promotion_min_paired_t: float = 1.5

    # Training
    train_min_dates: int = 250
    cv_folds: int = 5
    seeds: tuple[int, ...] = (11, 23, 47)
    recency_halflife_days: int = 500

    # Self-learning
    hedge_eta: float = 2.0
    hedge_shrink: float = 0.10
    conformal_target_coverage: float = 0.80
    conformal_gamma: float = 0.01

    http_timeout_s: float = 30.0
    http_max_retries: int = 4


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
