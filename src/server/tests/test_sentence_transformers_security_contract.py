"""Keep the local model-code trust boundary enforced across package upgrades."""

from pathlib import Path

import pytest
from sentence_transformers.util.misc import import_module_class


def test_local_custom_model_code_requires_explicit_trust(tmp_path: Path) -> None:
    # 5.6.x only warned and tried to load local custom code despite this false flag.
    with pytest.raises(ValueError, match="trust_remote_code=True"):
        import_module_class(
            "modeling_untrusted.Custom",
            str(tmp_path),
            trust_remote_code=False,
        )
