"""Reporting for importers that degrade instead of failing the release.

data/quarantine.json has one writer, scripts/lib/quarantine.mjs; Python importers go
through its command line, so the file's rules (each stage replaces its own entries,
firstSeen kept) live in one place. Report once per run, even with no entries: that is
what clears the stage's entries once its records recover.
"""
import json
import os
import subprocess
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'lib' / 'quarantine.mjs'

# ARKPEDIA_WIKI_BASE points every wiki reader somewhere else, e.g. an unreachable host
# to rehearse an outage; see wikiBase() in scripts/sync/catalogue-model.mjs.
WIKI_API = f"{os.environ.get('ARKPEDIA_WIKI_BASE', 'https://arknights.wiki.gg').rstrip('/')}/api.php"


def report(stage, entries, root=None):
    """Replace `stage`'s entries: [{key, reason, action, sourceRef?}]."""
    subprocess.run(['node', str(HELPER), stage], input=json.dumps(entries), text=True,
                   check=True, cwd=root or os.getcwd())
