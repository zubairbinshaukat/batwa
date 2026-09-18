"""Marketing artwork for batwa.zubyr.dev — OG card, avatar, hero webp set.

Usage:  python branding/make-og.py

Writes
  screenshots/og-batwa.png        1200x630 social card
  icons/author-192.webp           transparent circular avatar (1x)
  icons/author-384.webp           transparent circular avatar (2x)
  screenshots/hero-home.webp      + hero-home-sm.webp   (800px tall)
  screenshots/hero-spaces.webp    + hero-spaces-sm.webp (800px tall)

Nothing here belongs to the app shell: none of these files is precached by
sw.js. `make-icons.py` still owns the PWA icon set; the two do not overlap.
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OUTFIT = os.path.join(ROOT, "fonts", "outfit-var.woff2")
LOGO = os.path.join(ROOT, "branding", "logo.png")
AUTHOR_SRC = os.path.join(ROOT, "branding", "author-source.webp")

# Brand gradient ends, straight from css/tokens.css (--grad-hero light).
VIOLET_A = (79, 51, 232)   # #4F33E8
VIOLET_B = (98, 72, 245)   # #6248F5

# Nudge the square crop down the portrait if the face sits too high.
# Positive moves the crop DOWN, in source pixels. Default 0 = top of the
# alpha bbox, i.e. head and shoulders.
HEAD_OFFSET = 0

# Never upscale: the hero renders are ~1330px tall already.
HERO_MAX_H = 1400
HERO_SM_H = 800


def kb(path):
    return "%.0f KB" % (os.path.getsize(path) / 1024.0)


# ---------------------------------------------------------------- fonts
def outfit(size, weight=400):
    """Outfit at a weight. The repo only ships the variable woff2, and FreeType
    reads it happily; set_variation_by_axes picks the instance."""
    try:
        f = ImageFont.truetype(OUTFIT, size)
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.load_default(size)


# ---------------------------------------------------------------- OG card
def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def gradient(size, a, b):
    """Diagonal-ish violet wash: a vertical ramp rotated by a horizontal one."""
    w, h = size
    base = Image.new("RGB", (w, h), a)
    top = Image.new("RGB", (w, h), b)
    ramp = Image.new("L", (w, h))
    px = ramp.load()
    for y in range(h):
        for x in range(0, w, 8):
            v = int(255 * min(1.0, (x / w) * 0.72 + (y / h) * 0.42))
            for dx in range(8):
                if x + dx < w:
                    px[x + dx, y] = v
    base.paste(top, (0, 0), ramp)
    return base.convert("RGBA")


def make_og():
    W, H = 1200, 630
    card = gradient((W, H), VIOLET_A, VIOLET_B)

    # Two soft blooms, the same trick .canopy uses in CSS.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([-160, -260, 420, 320], fill=(255, 255, 255, 46))
    g.ellipse([760, 330, 1360, 930], fill=(63, 188, 248, 60))
    card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(90)))

    d = ImageDraw.Draw(card)

    logo = Image.open(LOGO).convert("RGBA")
    logo.thumbnail((104, 104), Image.LANCZOS)
    card.alpha_composite(logo, (72, 64))

    d.text((190, 84), "Batwa", font=outfit(46, 800), fill=(255, 255, 255, 255))
    d.text((192, 136), "by ZUBYR", font=outfit(24, 500), fill=(255, 255, 255, 190))

    d.text((72, 250), "Private offline", font=outfit(74, 800), fill=(255, 255, 255, 255))
    d.text((72, 336), "budget tracker", font=outfit(74, 800), fill=(255, 255, 255, 255))
    d.text((72, 448), "PIN-locked. Encrypted on your phone.", font=outfit(30, 500),
           fill=(255, 255, 255, 205))
    d.text((72, 492), "No account. No server. No tracking.", font=outfit(30, 500),
           fill=(255, 255, 255, 205))

    # The home screen, cropped to the top of the phone and tilted into a card.
    shot = Image.open(os.path.join(ROOT, "screenshots", "01-home.png")).convert("RGBA")
    target_w, target_h = 360, 540
    scale = target_w / shot.width
    shot = shot.resize((target_w, int(shot.height * scale)), Image.LANCZOS)
    shot = shot.crop((0, 0, target_w, min(target_h, shot.height)))
    shot = rounded(shot, 30)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", shot.size, (16, 6, 60, 120)), (786, 86), shot)
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))
    card.alpha_composite(shot, (780, 76))

    out = os.path.join(ROOT, "screenshots", "og-batwa.png")
    card.convert("RGB").save(out, optimize=True)
    print("wrote screenshots/og-batwa.png  %dx%d  %s" % (W, H, kb(out)))


# ---------------------------------------------------------------- avatar
def circle_mask(size, feather=1.0):
    """Circular alpha with a 1px feathered edge (supersampled, then blurred)."""
    ss = 4
    big = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(big).ellipse([0, 0, size * ss - 1, size * ss - 1], fill=255)
    m = big.resize((size, size), Image.LANCZOS)
    return m.filter(ImageFilter.GaussianBlur(feather))


def make_avatar():
    src = Image.open(AUTHOR_SRC).convert("RGBA")
    box = src.getchannel("A").getbbox()
    if not box:
        raise SystemExit("author-source.webp has no opaque pixels")
    left, top, right, bottom = box
    side = right - left
    top = min(top + HEAD_OFFSET, max(0, src.height - side))
    crop = (left, top, left + side, min(top + side, src.height))
    print("avatar crop box %s (alpha bbox %s, HEAD_OFFSET=%d)" % (crop, box, HEAD_OFFSET))
    head = src.crop(crop)
    if head.height != head.width:  # source ran out of pixels; pad transparently
        pad = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        pad.alpha_composite(head, (0, 0))
        head = pad

    for size in (192, 384):
        img = head.resize((size, size), Image.LANCZOS)
        mask = circle_mask(size)
        alpha = img.getchannel("A").point(lambda v: v)
        # Keep the cut-out's own transparency AND clip it to the circle, so
        # the CSS plate (--c-violet-soft) shows through behind the shoulders.
        img.putalpha(Image.composite(alpha, Image.new("L", (size, size), 0), mask))
        out = os.path.join(ROOT, "icons", "author-%d.webp" % size)
        img.save(out, "WEBP", quality=82, method=6)
        print("wrote icons/author-%d.webp  %dx%d  %s" % (size, size, size, kb(out)))


# ---------------------------------------------------------------- heroes
def make_hero(name):
    src = Image.open(os.path.join(ROOT, "screenshots", "%s.png" % name)).convert("RGBA")
    for suffix, max_h in (("", HERO_MAX_H), ("-sm", HERO_SM_H)):
        img = src
        if src.height > max_h:  # never upscale
            w = round(src.width * max_h / src.height)
            img = src.resize((w, max_h), Image.LANCZOS)
        out = os.path.join(ROOT, "screenshots", "%s%s.webp" % (name, suffix))
        quality = 80
        img.save(out, "WEBP", quality=quality, method=6)
        while os.path.getsize(out) > 220 * 1024 and quality > 55:
            quality -= 6
            img.save(out, "WEBP", quality=quality, method=6)
        print("wrote screenshots/%s%s.webp  %dx%d  q%d  %s"
              % (name, suffix, img.width, img.height, quality, kb(out)))


def main():
    make_og()
    make_avatar()
    make_hero("hero-home")
    make_hero("hero-spaces")


if __name__ == "__main__":
    main()
