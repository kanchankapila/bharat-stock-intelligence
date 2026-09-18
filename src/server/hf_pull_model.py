#!/usr/bin/env python3
"""
One-off HuggingFace cache warmer.
=================================
The scoring scripts set HF_HUB_OFFLINE=1 at module import (offline discipline, guarded
by src/server/tests/test_finbert_offline_load.py), so a model that is not already in the
local HF cache can NEVER be fetched at runtime. Run this once per new model in a process
that does NOT carry those env vars, to snapshot it into the local cache:

    python hf_pull_model.py yiyanghkust/finbert-tone     # finbert_scorer.py second engine
    python hf_pull_model.py ProsusAI/finbert
"""

import sys


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    from huggingface_hub import snapshot_download
    path = snapshot_download(sys.argv[1])
    print(f"[hf_pull_model] cached at: {path}")


if __name__ == "__main__":
    main()

