"""Reading the game client's own asset bundles from the official servers, for importers.

The client's files are Unity asset bundles listed per version in hot_update_list.json
({name, md5, totalSize} each), served as `<name with / -> _ and .ab -> .dat>`, a zip holding
the bundle. The bundles are compressed with the client's own LZ4 (each token's nibbles
swapped, each match offset big-endian), which UnityPy reads as LZHAM; decompress_lz4ak undoes
it. They are compressed, not encrypted: the game tables are what the client encrypts, and no
importer here reads them. Decided 2026-10-18: art from the official servers is taken on the
same basis as import-namecard-styles.py, which has read the theme bundles this way since #130.

What an importer gets: a region's version and file list, one bundle's bytes (fetched only when
asked), and a bundle's sprites as images under the client's own sprite names -- the names the
game-resource mirrors give their files (avatar/<avatarId>.png is the sprite <avatarId> of a
spritepack/ui_char_avatar_<n> bundle).

The addresses come from each region's network_config, as scripts/lib/official-endpoints.mjs
reads them; the requests name the site in their User-Agent. Needs UnityPy and lz4
(scripts/content/requirements.txt).
"""
import hashlib
import io
import json
import os
import ssl
import urllib.request
import zipfile
from pathlib import Path

USER_AGENT = 'ArkpediaBot/1.0 (+https://www.arkpedia.net)'
ROOT = Path(__file__).resolve().parents[2]
CLIENT_VERSIONS = ROOT / 'data' / 'client-versions.json'

NETWORK_CONFIG = {
    'en': 'https://ak-conf.arknights.global/config/prod/official/network_config',
    'jp': 'https://ak-conf.arknights.jp/config/prod/official/network_config',
    'kr': 'https://ak-conf.arknights.kr/config/prod/official/network_config',
    'cn': 'https://ak-conf.hypergryph.com/config/prod/official/network_config',
}


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


SSL = _ssl_context()


def get(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': USER_AGENT}), timeout=timeout, context=SSL) as response:
        return response.read()


def get_json(url: str):
    return json.loads(get(url))


def decompress_lz4ak(data: bytes, uncompressed_size: int) -> bytes:
    """The client's LZ4: undo the swapped token nibbles and big-endian offsets, then decode."""
    import lz4.block
    block = bytearray(data)
    pos, end = 0, len(block)
    while pos < end:
        token = block[pos]
        literal, match = token & 0x0F, token >> 4
        block[pos] = (literal << 4) | match
        pos += 1
        if literal == 0x0F:
            while pos < end:
                extra = block[pos]
                pos += 1
                literal += extra
                if extra != 0xFF:
                    break
        pos += literal
        if pos >= end:
            break
        block[pos], block[pos + 1] = block[pos + 1], block[pos]
        pos += 2
        if match == 0x0F:
            while pos < end:
                extra = block[pos]
                pos += 1
                if extra != 0xFF:
                    break
    return lz4.block.decompress(bytes(block), uncompressed_size)


def load(bundle: bytes):
    """A bundle as a UnityPy environment, with the client's LZ4 registered."""
    import UnityPy
    from UnityPy.enums.BundleFile import CompressionFlags
    from UnityPy.helpers import CompressionHelper
    CompressionHelper.DECOMPRESSION_MAP[CompressionFlags.LZHAM] = decompress_lz4ak
    return UnityPy.load(bundle)


def network(region: str) -> dict:
    """The region's addresses from its network_config: `hu` its file host (with /Android), `hv`
    its version file. CN keeps the version file on another host than the files."""
    wrapper = get_json(NETWORK_CONFIG[region])
    config = json.loads(wrapper['content']) if isinstance(wrapper.get('content'), str) else wrapper
    values = config['configs'][config['funcVer']]['network']
    return {'hu': f"{values['hu'].rstrip('/')}/Android", 'hv': values['hv'].replace('{0}', 'Android')}


def res_version(region: str, version_url: str) -> str:
    """The region's live resVersion: the watcher's record from this run when it has one
    (scripts/sync/watch-client-versions.mjs runs first), else the client's version file."""
    if CLIENT_VERSIONS.exists():
        recorded = json.loads(CLIENT_VERSIONS.read_text()).get('regions', {}).get(region, {}).get('resVersion')
        if recorded:
            return recorded
    return get_json(version_url)['resVersion']


class Client:
    """One region's client at one version: its file list and its bundles."""

    def __init__(self, region: str, host: str = None, version: str = None, fetch=get):
        self.region = region
        self.fetch = fetch
        addresses = None if host and version else network(region)
        self.host = host or addresses['hu']
        self.version = version or res_version(region, addresses['hv'])
        self._files = None

    def files(self) -> dict:
        """{bundle name: md5} for this version."""
        if self._files is None:
            listing = json.loads(self.fetch(f'{self.host}/assets/{self.version}/hot_update_list.json'))
            if listing.get('versionId') not in (None, self.version):
                raise ValueError(f"the {self.region} file list is for {listing.get('versionId')}, not {self.version}")
            self._files = {info['name']: info.get('md5', '') for info in listing['abInfos']}
        return self._files

    def bundle(self, name: str) -> bytes:
        """One bundle's bytes, out of the zip the server sends it in."""
        url = f'{self.host}/assets/{self.version}/' + name.replace('/', '_').replace('.ab', '.dat').replace('[', '%5B').replace(']', '%5D')
        archive = zipfile.ZipFile(io.BytesIO(self.fetch(url)))
        return archive.read(archive.namelist()[0])


def sprites(bundle: bytes):
    """(sprite name, RGBA image) for every sprite in a bundle."""
    env = load(bundle)
    for obj in env.objects:
        if obj.type.name != 'Sprite':
            continue
        sprite = obj.read()
        yield sprite.m_Name, sprite.image.convert('RGBA')


def pixel_hash(image) -> str:
    """The same for two images with the same size and pixels, however each file encodes them."""
    rgba = image.convert('RGBA')
    return hashlib.sha1(f'{rgba.width}x{rgba.height}:'.encode() + rgba.tobytes()).hexdigest()[:16]
