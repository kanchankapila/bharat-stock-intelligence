"""
Ingress Governor & Resilient Fetcher Framework (Phase 1).

Provides:
- Exponential backoff retry decorators using tenacity for HTTP network calls.
- Pydantic v2 validation wrappers for external API payload schemas.
- Centralized dead-letter reporting for malformed vendor payloads.
"""

import polars as pl
import logging
from typing import Any, Callable, Type, TypeVar
import httpx
import requests
from pydantic import BaseModel, ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)

logger = logging.getLogger("ingress_governor")

T = TypeVar("T", bound=BaseModel)

# Transport errors and temporary server/rate-limit HTTP status errors
RETRYABLE_EXCEPTIONS = (
    requests.RequestException,
    httpx.HTTPError,
    ConnectionError,
    TimeoutError,
)


def retryable_fetcher(
    max_attempts: int = 4,
    min_wait_sec: float = 1.0,
    max_wait_sec: float = 10.0,
):
    """Decorator applying exponential backoff retry with jitter to HTTP fetching functions.

    Automatically retries on network disconnects, timeouts, and temporary HTTP errors.
    """
    return retry(
        retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),
        stop=stop_after_attempt(max_attempts),
        wait=wait_random_exponential(min=min_wait_sec, max=max_wait_sec),
        reraise=True,
    )


def validate_payload(data: Any, model_class: Type[T]) -> T | None:
    """Validates raw dict/payload against a Pydantic model.

    Returns validated model instance if valid, or None if malformed (logging the validation error
    to avoid crashing batch ingestion jobs).
    """
    try:
        if isinstance(data, dict):
            return model_class.model_validate(data)
        return model_class.model_validate_json(data)
    except ValidationError as err:
        logger.warning(
            "Ingress schema validation failed for %s: %s",
            model_class.__name__,
            err.errors(include_url=False),
        )
        return None

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
