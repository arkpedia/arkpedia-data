"""Availability lookup for importers after media moved to public repositories."""
import json
from functools import lru_cache
from pathlib import Path

@lru_cache(maxsize=1)
def published_assets():
    index = Path(__file__).resolve().parents[2] / 'data/assets/external-asset-index.json'
    return frozenset(json.loads(index.read_text())['files'])
