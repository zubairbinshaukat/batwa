"""LinkedIn / case-study cover for Batwa.

Usage:  python branding/make-cover.py

Writes
  zubyr-export/images/batwa/cover-linkedin.png   2400x1600, sRGB PNG
  zubyr-export/images/batwa/cover-linkedin.jpg   same, q92 (smaller upload)

Same recipe as the original 1200x800 cover.webp (dark #0A0A0B ground, gradient
rule, Outfit title, mono tags, phone frames) but at 2x, with the title block
pulled up so all three visuals fit fully inside the canvas, and the shared
spaces hero render on the left instead of the history screen.
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTFIT = os.path.join(ROOT, "fonts", "outfit-var.woff2")
MONO = r"C:\Windows\Fonts\consola.ttf"
OUT_DIR = os.path.join(ROOT, "zubyr-export", "images", "batwa")

W, H = 2400, 1600
GROUND = (10, 10, 11)
VIOLET = (98, 72, 245)     # #6248F5
PINK = (236, 72, 153)      # rule gradient end

TAGS = ["Offline-first budget PWA", "encrypted on the phone", "shared spaces", "no account"]


def outfit(size, weight=400):
    f = ImageFont.truetype(OUTFIT, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def mono(size):
    try:
        return ImageFont.truetype(MONO, size)
    except Exception:
        return ImageFont.load_default(size)


def rounded(img, radius):
    ss = 3
    mask = Image.new("L", (img.width * ss, img.height * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.width * ss - 1, img.height * ss - 1], radius * ss, fill=255)
    mask = mask.resize(img.size, Image.LANCZOS)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def frame(name, height):
    """A flat screenshot as a rounded phone frame with a thin light bezel."""
    shot = Image.open(os.path.join(ROOT, "screenshots", name)).convert("RGBA")
    w = round(shot.width * height / shot.height)
    shot = shot.resize((w, height), Image.LANCZOS)
    r = round(height * 0.052)
    shot = rounded(shot, r)
    bezel = 6
    plate = Image.new("RGBA", (w + bezel * 2, height + bezel * 2), (0, 0, 0, 0))
    plate.paste(rounded(Image.new("RGBA", plate.size, (255, 255, 255, 235)), r + bezel), (0, 0))
    plate.alpha_composite(shot, (bezel, bezel))
    return plate


def drop_shadow(canvas, layer, pos, blur=40, alpha=150, dy=24):
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", layer.size, (0, 0, 0, alpha)), (pos[0], pos[1] + dy), layer)
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))


def main():
    card = Image.new("RGBA", (W, H), GROUND + (255,))

    # Soft violet bloom under the phones, like the original cover's lower haze.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([300, 900, 2100, 2000], fill=(70, 50, 170, 70))
    card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(220)))

    d = ImageDraw.Draw(card)

    # ---- title block, pulled up
    x0, y = 144, 96
    rule = Image.new("RGBA", (240, 8), (0, 0, 0, 0))
    rp = rule.load()
    for i in range(240):
        t = i / 239
        c = tuple(round(VIOLET[k] * (1 - t) + PINK[k] * t) for k in range(3)) + (255,)
        for j in range(8):
            rp[i, j] = c
    card.alpha_composite(rounded(rule, 4), (x0, y))

    d.text((x0 - 6, y + 40), "Batwa", font=outfit(150, 800), fill=(255, 255, 255, 255))

    tag_font = mono(38)
    ty = y + 236
    tx = x0
    for i, t in enumerate(TAGS):
        d.text((tx, ty), t, font=tag_font, fill=(200, 196, 214, 255))
        tx += d.textlength(t, font=tag_font)
        if i < len(TAGS) - 1:
            d.text((tx + 34, ty), "\u00b7", font=tag_font, fill=(130, 126, 150, 255))
            tx += 34 * 2 + d.textlength("\u00b7", font=tag_font)

    # ---- visuals: spaces hero left, home centre (tallest), reports right
    top = 430
    bottom = H - 70
    side_h = bottom - top - 60
    centre_h = bottom - top

    home = frame("01-home.png", centre_h)
    reports = frame("02-reports.png", side_h)

    spaces = Image.open(os.path.join(ROOT, "screenshots", "hero-spaces.png")).convert("RGBA")
    sp_h = round(centre_h * 1.12)
    spaces = spaces.resize((round(spaces.width * sp_h / spaces.height), sp_h), Image.LANCZOS)

    gap = 72
    total = spaces.width - 100 + gap + home.width + gap + reports.width
    x = (W - total) // 2 + 10

    sx, sy = x - 60, bottom - sp_h + 60
    drop_shadow(card, spaces, (sx, sy), blur=60, alpha=110, dy=30)
    card.alpha_composite(spaces, (sx, sy))
    x += spaces.width - 100 + gap

    hx, hy = x, top
    drop_shadow(card, home, (hx, hy))
    card.alpha_composite(home, (hx, hy))
    x += home.width + gap

    rx, ry = x, top + 60
    drop_shadow(card, reports, (rx, ry))
    card.alpha_composite(reports, (rx, ry))

    os.makedirs(OUT_DIR, exist_ok=True)
    rgb = card.convert("RGB")
    png = os.path.join(OUT_DIR, "cover-linkedin.png")
    jpg = os.path.join(OUT_DIR, "cover-linkedin.jpg")
    rgb.save(png, optimize=True)
    rgb.save(jpg, quality=92, subsampling=0, optimize=True)
    for p in (png, jpg):
        print("wrote %s  %dx%d  %.0f KB" % (os.path.relpath(p, ROOT), W, H, os.path.getsize(p) / 1024))


if __name__ == "__main__":
    main()
