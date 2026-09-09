"""Minimal thread-safe TTL cache with stale-while-error semantics."""
import threading
import time


class TTLCache:
    def __init__(self):
        self._data: dict = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            value, expires_at = item
            return value if time.time() < expires_at else None

    def get_or_stale(self, key):
        """Return value even if expired (better than an error when DB is slow)."""
        with self._lock:
            item = self._data.get(key)
            return item[0] if item else None

    def set(self, key, value, ttl_seconds: float):
        with self._lock:
            self._data[key] = (value, time.time() + ttl_seconds)

    def set_pending(self, key):
        self.set(key, {"__pending__": True}, ttl_seconds=1)


CACHE = TTLCache()
