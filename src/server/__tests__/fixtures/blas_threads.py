"""Print the thread count OpenBLAS actually resolved (not the env var) for runPython tests."""
import numpy  # noqa: F401  (loads OpenBLAS)
from threadpoolctl import threadpool_info

counts = [i["num_threads"] for i in threadpool_info() if i.get("internal_api") == "openblas"]
print(f"OPENBLAS_THREADS={counts[0] if counts else 'none'}")
