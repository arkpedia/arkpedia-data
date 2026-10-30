"""Exact source-pixel samples shared by the local reviewer and generator."""
import hashlib
import json
import re
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REVIEWS = ROOT / 'data' / 'color-palette-reviews.json'


def load_reviews(path=REVIEWS):
    return json.loads(path.read_text()) if path.exists() else {'version': 1, 'artworks': {}}


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write('\n')
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def review_digest(review):
    if review.get('status') == 'accepted':
        values = [review['sourceSha256'], 'accepted', review['colors']]
        return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()
    values = [review['sourceSha256'], [[s['x'], s['y'], s['color'], s['label']] for s in review['samples']]]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def validate_review(review, image, source_sha):
    """Validate against the original RGBA pixels, never the rendered thumbnail."""
    if not isinstance(review, dict):
        raise ValueError('Invalid review.')
    if review.get('sourceSha256') != source_sha:
        raise ValueError('Artwork changed. Reload it and review the sample positions again.')
    if review.get('status') not in ('draft', 'flagged', 'declined', 'approved'):
        raise ValueError('Choose draft, flagged, or approved.')
    samples = review.get('samples')
    if not isinstance(samples, list) or len(samples) != 5:
        raise ValueError('A review needs five feature slots.')
    labels = review.get('labels', [s.get('label', '') if isinstance(s, dict) else '' for s in samples])
    if not isinstance(labels, list) or len(labels) != 5 or any(not isinstance(label, str) or len(label) > 100 for label in labels):
        raise ValueError('Feature descriptions must be under 100 characters.')
    if not isinstance(review.get('notes', ''), str) or len(review.get('notes', '')) > 2000:
        raise ValueError('Keep review notes under 2,000 characters.')
    rgba = image.convert('RGBA')
    cleaned = []
    for sample in samples:
        if sample is None:
            if review['status'] == 'approved':
                raise ValueError('Sample and describe all five features before approving.')
            cleaned.append(None)
            continue
        if not isinstance(sample, dict):
            raise ValueError('Invalid source sample.')
        x, y = sample.get('x'), sample.get('y')
        if type(x) is not int or type(y) is not int or not (0 <= x < image.width and 0 <= y < image.height):
            raise ValueError('Sample positions must be inside the original artwork.')
        r, g, b, alpha = rgba.getpixel((x, y))
        if alpha < 192:
            raise ValueError('Choose an opaque part of the artwork, away from transparent edges.')
        color = '#%02x%02x%02x' % (r, g, b)
        if sample.get('color') != color:
            raise ValueError('A sample color does not match its source pixel. Sample it again.')
        label = sample.get('label', '')
        if not isinstance(label, str) or len(label) > 100 or (review['status'] == 'approved' and not label.strip()):
            raise ValueError('Describe the feature for each approved sample (up to 100 characters).')
        cleaned.append({'x': x, 'y': y, 'color': color, 'label': label.strip()})
    return {'sourceSha256': source_sha, 'status': review['status'], 'samples': cleaned,
            'labels': [s['label'] if s else labels[i].strip() for i, s in enumerate(cleaned)],
            'notes': review.get('notes', '').strip()}


def approved_palette(review, image, source_sha):
    if review and review.get('status') == 'accepted':
        if review.get('sourceSha256') != source_sha:
            raise ValueError('Artwork changed. Review its accepted palette again.')
        colors = review.get('colors')
        if not isinstance(colors, list) or len(colors) != 5 or any(not isinstance(c, str) or not re.fullmatch(r'#[0-9a-f]{6}', c) for c in colors):
            raise ValueError('An accepted suggestion needs five valid colors.')
        return {'colors': colors, 'sha256': source_sha, 'reviewSha256': review_digest(review)}
    if not review or review.get('status') != 'approved':
        return None
    clean = validate_review(review, image, source_sha)
    return {'colors': [s['color'] for s in clean['samples']], 'sha256': source_sha, 'reviewSha256': review_digest(clean)}
