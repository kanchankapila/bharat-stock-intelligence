"""dl_engine must configure the CUDA allocator under torch's current env-var name.

PYTORCH_CUDA_ALLOC_CONF is deprecated in torch 2.9: setting it prints
"PYTORCH_CUDA_ALLOC_CONF is deprecated, use PYTORCH_ALLOC_CONF instead" on every CUDA run
(14 times in the recent pm2 error log, 2026-10-28), noise every stderr classifier must then mute.
Checked in a clean subprocess because torch reads the variable when the allocator initialises.
"""
import os
import subprocess
import sys

import pytest

torch = pytest.importorskip("torch")

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.skipif(not torch.cuda.is_available(), reason="needs a CUDA device")
def test_cuda_allocation_after_import_prints_no_deprecation_warning():
    env = {k: v for k, v in os.environ.items() if k not in ("PYTORCH_CUDA_ALLOC_CONF", "PYTORCH_ALLOC_CONF")}
    proc = subprocess.run(
        [sys.executable, "-c", "import dl_engine, torch; torch.zeros(1, device='cuda'); print('ok')"],
        cwd=SERVER_DIR, env=env, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "PYTORCH_CUDA_ALLOC_CONF is deprecated" not in proc.stderr
