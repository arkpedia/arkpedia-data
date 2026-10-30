"""Art an importer fetched that arkpedia-image-assets does not publish yet, staged for the
release's staged-art stage to publish (config/staged-art.json says which kinds there are).

An importer never writes art under public/ -- check:assets refuses any image there -- and
never publishes it itself. It stages each file in .cache/<kind>/ and lists it, with its
destination in the image repository and where it came from, in .cache/<kind>/staged.json:

    staging = Staging('cc-stages')                 # forgets the last run's list
    staging.stage('stages-images/crisis_v2_09-01.webp', data, source=url, mirror=...)
    staging.commit()                               # writes this run's list

The list is written last, so an importer that fails part-way stages nothing, and the file
is the source art as fetched (or, for a crest, the mask cut from it), losslessly: the
publisher (scripts/sync/publish-catalogue-assets.py) does the one encode, at the size its
destination folder takes. The same rules live in scripts/lib/staged-art.mjs for the Node
importers.
"""
import hashlib
import io
import json
import os
import re
from pathlib import Path

from PIL import Image

REGISTRY = Path(__file__).resolve().parents[2]/'config/staged-art.json'
SIDECAR = 'staged.json'
FORMATS = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp', 'GIF': 'gif'}


def git_blob(data):
    """The git blob id of `data`: how a mirror's tree names these exact bytes."""
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def registry():
    return json.loads(REGISTRY.read_text())['kinds']


class Staging:
    """One importer's staged art for this run. Creating it removes the last run's list."""

    def __init__(self, kind, root=None):
        kinds = registry()
        if kind not in kinds:
            raise ValueError(f'{kind} is not a staged art kind in {REGISTRY.name}; add it there so the staged-art stage publishes it')
        self.kind, self.folders = kind, kinds[kind]['folders']
        self.dir = Path(root or os.getcwd())/'.cache'/kind
        self.files = {}
        (self.dir/SIDECAR).unlink(missing_ok=True)

    def path(self, target, extension):
        """Where the file for `target` is staged: its destination's stem, the source's extension."""
        return self.dir/f'{Path(target).stem}.{extension}'

    def previous(self, target):
        """The file an earlier run on this machine staged for `target`, in whichever format the
        source served it, or None."""
        return next((file for extension in FORMATS.values() if (file := self.path(target, extension)).exists()), None)

    def stage(self, target, data, *, source, mirror=None):
        """Stage `data` (the image's bytes) for `target`, a path in the image repository.

        `source` is the URL it came from, pinned to a commit where the source has one.
        `mirror` names the file in a game-resource mirror -- {repository, path, commit} --
        when it is one, so the image repository can map it for its daily sync. Returns the
        staged file's path."""
        folder = target.split('/')[0]
        if folder not in self.folders or '..' in Path(target).parts or not re.fullmatch(r'[^/]+/[^/]+\.(webp|png)', target):
            raise ValueError(f'{self.kind} cannot stage {target}: it publishes only into {", ".join(self.folders)}/')
        if not isinstance(source, str) or not re.match(r'https?://', source):
            raise ValueError(f'{target} needs the URL it came from, not {source!r}')
        with Image.open(io.BytesIO(data)) as image:
            extension = FORMATS.get(image.format)
        if not extension:
            raise ValueError(f'{target}: staged art must be PNG, JPEG, WebP or GIF')
        file = self.path(target, extension)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        row = {'file': file.name, 'source': source, 'sha256': hashlib.sha256(data).hexdigest()}
        if mirror:
            if not (mirror.get('repository') and mirror.get('path') and re.fullmatch(r'[0-9a-f]{40}', mirror.get('commit') or '')):
                raise ValueError(f'{target}: a mirror file needs its repository, path and pinned commit')
            row['mirror'] = {**mirror, 'blob': git_blob(data)}
        self.files[target] = row
        return file

    def image(self, target, image, *, source):
        """Stage a PIL image made here (a crest's mask), as a lossless PNG."""
        buffer = io.BytesIO()
        image.save(buffer, 'PNG')
        return self.stage(target, buffer.getvalue(), source=source)

    def commit(self):
        if not self.files:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps({'version': 1, 'kind': self.kind, 'files': dict(sorted(self.files.items()))}, ensure_ascii=False, indent=2) + '\n'
        (self.dir/f'{SIDECAR}.tmp').write_text(text)
        os.replace(self.dir/f'{SIDECAR}.tmp', self.dir/SIDECAR)
