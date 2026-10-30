"""An Arknights: Endfield album's cover, cut from its first song's YouTube thumbnail
(scripts/sync/sync-endfield-albums.mjs, which stages it for arkpedia-image-assets album-covers/).

The label's uploads are YouTube's auto-generated art tracks: a 16:9 frame (1280x720 at
maxresdefault) with the album's square art at full height in the middle and one plain colour
either side. The cover is that square, cut losslessly; the publisher does the one encode, at
the 500px album-covers/ takes (scripts/sync/publish-catalogue-assets.py).

A cover is published once and its record never changes after (coverFilename), so any frame
that is not that layout is refused rather than cut: not 16:9, under 500px high (the cover
would be published smaller than every other), or with sides that are not plain (the art is
not where the crop takes it). All 28 albums' frames in 2026-10 had sides within 5 levels of
their mean colour.

    python3 scripts/imports/square_album_cover.py < frame.jpg > cover.png

Writes the square as PNG on stdout; exits 2, saying why on stderr, for a frame it refuses.
"""
import io
import sys

from PIL import Image, ImageStat

# The smallest square kept: the album-covers/ size every other cover is published at.
MIN_SIDE = 500
# The most a side's colour may vary, as a standard deviation per channel (0-255).
PLAIN = 16


class Refused(ValueError):
    pass


def square_cover(data):
    """The centred square of a 16:9 art-track frame, as PNG bytes."""
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise Refused(f'not an image that decodes ({exc})') from exc
    image = image.convert('RGB')
    width, height = image.size
    if abs(width * 9 - height * 16) > 16:
        raise Refused(f'the frame is {width}x{height}, not 16:9')
    if height < MIN_SIDE:
        raise Refused(f'the frame is {height}px high, under the {MIN_SIDE}px of a published cover')
    left = (width - height) // 2
    for name, box in (('left', (0, 0, left, height)), ('right', (left + height, 0, width, height))):
        spread = max(ImageStat.Stat(image.crop(box)).stddev)
        if spread > PLAIN:
            raise Refused(f'its {name} side is not one plain colour (spread {spread:.1f}), so the art is not a centred square')
    output = io.BytesIO()
    image.crop((left, 0, left + height, height)).save(output, format='PNG')
    return output.getvalue()


def main():
    try:
        sys.stdout.buffer.write(square_cover(sys.stdin.buffer.read()))
    except Refused as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
