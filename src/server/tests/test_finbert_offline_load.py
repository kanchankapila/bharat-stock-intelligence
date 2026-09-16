"""Guards the ONE thing that can silently break the local-model load: ordering.

`HF_HUB_OFFLINE` is snapshotted into huggingface_hub.constants at import time, so setting it
after `from transformers import pipeline` is a no-op that fails open -- FinBERT still works, it
just goes back to calling the Hub and writing warnings to stderr on every runPython(). Nothing
errors, which is why this needs a test rather than a comment.
"""
import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]


def _hub_offline_after_import(module: str) -> bool:
    """Import the module in a clean interpreter, report what huggingface_hub actually resolved.

    Reads hub's own constant, NOT os.environ -- setdefault sets the var whether it runs before
    or after the import, so an os.environ assertion passes against the broken ordering too.
    """
    out = subprocess.run(
        [sys.executable, "-c",
         f"import os;os.environ.pop('HF_HUB_OFFLINE',None);import {module};"
         f"import huggingface_hub.constants as c;print('OFFLINE=',bool(c.HF_HUB_OFFLINE))"],
        cwd=SERVER_DIR, capture_output=True, text=True, timeout=180,
    )
    assert out.returncode == 0, out.stderr
    return "OFFLINE= True" in out.stdout


def test_nlp_engine_sets_offline_before_transformers_import():
    assert _hub_offline_after_import("nlp_engine")


def test_finbert_scorer_sets_offline_before_transformers_import():
    assert _hub_offline_after_import("finbert_scorer")
