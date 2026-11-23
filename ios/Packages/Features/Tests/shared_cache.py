"""Paths shared by runner-managed macOS seats; local drills keep isolated output otherwise."""
import os
import sys
from pathlib import Path


def derived_data_path(out: Path, local_name: str) -> Path:
    shared = os.environ.get("TRANTOR_SHARED_CACHE")
    if sys.platform == "darwin" and shared:
        path = Path(shared) / "DerivedData"
        path.mkdir(parents=True, exist_ok=True)
        return path
    return out / local_name
