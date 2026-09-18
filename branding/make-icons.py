"""Regenerate the Batwa PWA icon set from the clay wallet source render.

Usage:  python branding/make-icons.py [source.png]
Default source is branding/logo-source.png. Outputs into icons/.
"""
import os
import sys
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Chrome decides a WebAPK needs re-minting by diffing the manifest, so changed
# artwork behind an unchanged filename can sit stale on a phone for days. Bump
# this whenever the logo changes, and update the references in
# manifest.webmanifest, sw.js, index.html and js/auth.js to match.
SUFFIX = "-v2"
PLATE = (239, 236, 254, 255)  # #EFECFE, the brand lavender surface


def load_clean(path):
    """Trim the render to its subject and strip the AI speckle around it."""
    src = Image.open(path).convert("RGBA")
    alpha = src.getchannel("A")
    solid = alpha.point(lambda v: 255 if v >= 60 else 0)
    # opening drops the stray specks, closing puts the soft edges back
    keep = solid.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
    keep = keep.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
    keep = keep.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
    src.putalpha(Image.eval(Image.merge("L", (alpha,)), lambda v: v))
    cleaned = Image.new("RGBA", src.size, (0, 0, 0, 0))
    cleaned.paste(src, (0, 0), keep)
    return cleaned.crop(cleaned.getchannel("A").getbbox())


def render(subject, size, scale, bg=None):
    """Center `subject` on a `size` canvas, fitting it to `scale` of the edge."""
    box = int(round(size * scale))
    fitted = subject.copy()
    fitted.thumbnail((box, box), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    canvas.alpha_composite(
        fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2)
    )
    return canvas


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "branding", "logo-source.png")
    subject = load_clean(source)
    out = os.path.join(ROOT, "icons")

    jobs = [
        # transparent, near-full-bleed: browsers and Android "any" slots
        ("icon-192%s.png" % SUFFIX, 192, 0.92, None),
        ("icon-512%s.png" % SUFFIX, 512, 0.92, None),
        # maskable: content stays inside the maskable safe zone; the subject is
        # round enough that its corners can push past the strict circle
        ("icon-maskable-192%s.png" % SUFFIX, 192, 0.62, PLATE),
        ("icon-maskable-512%s.png" % SUFFIX, 512, 0.62, PLATE),
        # iOS flattens transparency to black, so this one needs the plate
        ("apple-touch-icon-180%s.png" % SUFFIX, 180, 0.80, PLATE),
    ]
    for name, size, scale, bg in jobs:
        img = render(subject, size, scale, bg)
        if bg is not None:
            img = img.convert("RGB")
        img.save(os.path.join(out, name), optimize=True)
        print("wrote icons/%s  %dx%d" % (name, size, size))


if __name__ == "__main__":
    main()
