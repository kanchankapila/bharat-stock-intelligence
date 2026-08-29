"""
Standardized BaseFetcher Framework with Pydantic v2 Ingress Contracts,
Rate-Limiting Token Bucket, Circuit Breaker, and Dead-Letter Queue (DLQ).
"""

import polars as pl
import logging
import time
from typing import Any, Callable, Dict, Generic, List, Optional, Type, TypeVar
import httpx
import requests
from pydantic import BaseModel, ValidationError

logger = logging.getLogger("base_fetcher")

T = TypeVar("T", bound=BaseModel)


class CircuitBreakerOpen(Exception):
    """Raised when a domain circuit breaker is open due to repeated 429/403 blocks."""
    pass


class DomainGovernor:
    """Manages rate-limiting token buckets and circuit breakers per domain host."""

    _instances: Dict[str, "DomainGovernor"] = {}

    def __init__(self, domain: str, min_interval_sec: float = 0.5, cooldown_sec: float = 900.0):
        self.domain = domain
        self.min_interval_sec = min_interval_sec
        self.cooldown_sec = cooldown_sec
        self.last_request_time: float = 0.0
        self.consecutive_errors: int = 0
        self.circuit_open_until: float = 0.0

    @classmethod
    def get(cls, domain: str, min_interval_sec: float = 0.5) -> "DomainGovernor":
        if domain not in cls._instances:
            cls._instances[domain] = cls(domain, min_interval_sec=min_interval_sec)
        return cls._instances[domain]

    def acquire(self) -> None:
        now = time.time()
        if now < self.circuit_open_until:
            remaining = int(self.circuit_open_until - now)
            raise CircuitBreakerOpen(
                f"Circuit breaker OPEN for domain '{self.domain}'. Cooldown remaining: {remaining}s"
            )

        elapsed = now - self.last_request_time
        if elapsed < self.min_interval_sec:
            time.sleep(self.min_interval_sec - elapsed)
        self.last_request_time = time.time()

    def record_success(self) -> None:
        self.consecutive_errors = 0

    def record_error(self, status_code: Optional[int] = None) -> None:
        self.consecutive_errors += 1
        if status_code in (403, 429) or self.consecutive_errors >= 5:
            self.circuit_open_until = time.time() + self.cooldown_sec
            logger.error(
                "Circuit breaker TRIPPED for domain '%s' (status %s, errors=%d). Pausing for %ds",
                self.domain,
                status_code,
                self.consecutive_errors,
                int(self.cooldown_sec),
            )


def record_dlq(conn, fetcher_name: str, domain: str, payload_sample: str, error_msg: str) -> None:
    """Writes a failed payload or validation failure to data_ingestion_dlq."""
    try:
        if conn is not None:
            conn.execute(
                """
                INSERT INTO data_ingestion_dlq (fetcher_name, domain, payload_sample, error_message, created_at, status)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'NEW')
                """,
                (fetcher_name, domain, payload_sample[:2000], error_msg[:1000]),
            )
            if hasattr(conn, "commit"):
                conn.commit()
    except Exception as exc:
        logger.error("Failed to record DLQ entry: %s", exc)
def governed_fetcher(domain: str, fetcher_name: str = "GenericFetcher", min_interval_sec: float = 0.5):
    """Decorator wrapping any fetcher function with rate limiting, circuit breaking, and DLQ reporting."""
    def decorator(func: Callable):
        governor = DomainGovernor.get(domain, min_interval_sec=min_interval_sec)

        def wrapper(*args, **kwargs):
            governor.acquire()
            try:
                result = func(*args, **kwargs)
                governor.record_success()
                return result
            except Exception as exc:
                governor.record_error()
                conn = kwargs.get("conn") or (args[0] if args and hasattr(args[0], "execute") else None)
                record_dlq(conn, fetcher_name, domain, str(args), str(exc))
                raise exc
        return wrapper
    return decorator




class BaseFetcher(Generic[T]):
    """Base class for Python ingestion fetchers enforcing schema contracts and resilience."""

    fetcher_name: str = "BaseFetcher"
    domain: str = "general"
    schema: Optional[Type[T]] = None
    min_interval_sec: float = 0.5
    max_retries: int = 4

    def __init__(self, conn=None):
        self.conn = conn
        self.governor = DomainGovernor.get(self.domain, min_interval_sec=self.min_interval_sec)

    def fetch_url(self, url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 15.0) -> Optional[str]:
        """Fetches URL with rate limiting, circuit breaker, and retry backoff."""
        self.governor.acquire()
        default_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/html, */*",
        }
        if headers:
            default_headers.update(headers)

        for attempt in range(1, self.max_retries + 1):
            try:
                resp = requests.get(url, headers=default_headers, timeout=timeout)
                if resp.status_code == 200:
                    self.governor.record_success()
                    return resp.text
                elif resp.status_code in (403, 429):
                    self.governor.record_error(resp.status_code)
                    record_dlq(
                        self.conn,
                        self.fetcher_name,
                        self.domain,
                        url,
                        f"HTTP {resp.status_code}: Rate limited / forbidden",
                    )
                    return None
                else:
                    logger.warning("Attempt %d HTTP %d for %s", attempt, resp.status_code, url)
            except Exception as exc:
                logger.warning("Attempt %d network error for %s: %s", attempt, url, exc)
            time.sleep(1.0 * (2 ** (attempt - 1)))

        self.governor.record_error()
        record_dlq(self.conn, self.fetcher_name, self.domain, url, f"Failed after {self.max_retries} attempts")
        return None

    def validate_item(self, raw_item: Dict[str, Any]) -> Optional[T]:
        """Validates raw dict payload against Pydantic schema if defined."""
        if not self.schema:
            return raw_item  # type: ignore

        try:
            return self.schema.model_validate(raw_item)
        except ValidationError as val_err:
            error_str = str(val_err)
            logger.warning("[%s] Validation error: %s", self.fetcher_name, error_str)
            record_dlq(
                self.conn,
                self.fetcher_name,
                self.domain,
                str(raw_item),
                f"ValidationError: {error_str}",
            )
            return None

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
