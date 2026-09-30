"""finbert_news_sentiment.py must never touch the GPU (2026-09-30 memory-contention fix).

Checked in a clean subprocess: CUDA_VISIBLE_DEVICES only works if set before torch initialises
CUDA, and asserting os.environ in-process would pass even if the ordering were wrong.
"""
import os
import subprocess
import sys

SERVER = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def test_importing_the_script_hides_cuda_from_torch():
    code = ("import finbert_news_sentiment, torch; "
            "print('CUDA', torch.cuda.is_available())")
    env = {k: v for k, v in os.environ.items() if k != "CUDA_VISIBLE_DEVICES"}
    env["USE_FINBERT"] = "false"
    out = subprocess.run([sys.executable, "-c", code], cwd=SERVER, env=env,
                         capture_output=True, text=True, timeout=300)
    assert "CUDA False" in out.stdout, out.stdout + out.stderr
