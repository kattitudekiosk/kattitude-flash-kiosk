#!/usr/bin/env python3
"""
generate-seed.py — placeholder content generator for the Flash Gallery kiosk.

WHY THIS EXISTS
---------------
The studio has 4 composed flash sheets and zero individual design files. The
new kiosk UX (hybrid grid, filter chips, artist pages, detail swipe) cannot be
built or visually verified against an empty catalog, so this script fabricates
a believable catalog: labelled 2048x2048 transparent PNGs, 512px WebP thumbs,
artist portraits, and a generated `seed/seed-data.js`.

Everything it emits is disposable. Nothing else in the app imports from here —
the kiosk reads a normalized catalog (see catalog.js), and seed is just one
possible source of that catalog. When real flash is cut, point the catalog at
the live source and delete `assets/seed/`. No app code changes.

USAGE
-----
    python3 tools/generate-seed.py            # regenerate everything
    python3 tools/generate-seed.py --clean    # delete generated output

Requires Pillow (`pip install Pillow`). Not needed at runtime or to deploy —
this is an authoring-time tool only.
"""

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_ASSETS = os.path.join(ROOT, "assets", "seed")
DESIGN_DIR = os.path.join(SEED_ASSETS, "designs")
THUMB_DIR = os.path.join(SEED_ASSETS, "thumbs")
PORTRAIT_DIR = os.path.join(SEED_ASSETS, "artists")
SEED_DATA_JS = os.path.join(ROOT, "seed", "seed-data.js")

# Spec straight out of the PRD §4.1.
DESIGN_PX = 2048
THUMB_PX = 512
PORTRAIT_PX = 1024

INK = (26, 26, 26, 255)
PINK = (233, 30, 140, 255)

# The logo's yellow. There used to be a separate #B8860B "gold" here, which is
# why regenerating was needed after the CSS switched — the palette baked into
# the PNGs is independent of the stylesheet, so a colour change is only really
# done once both have moved.
YELLOW = (253, 228, 70, 255)

# Yellow at full strength is ~1.3:1 on white, so it is unusable for line art
# on the white design tiles. Designs therefore draw in ink and pink only;
# yellow is reserved for the portraits, which sit on a dark ground.
DESIGN_ACCENT = PINK

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Futura.ttc",
    "/Library/Fonts/Arial Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ── Catalog definition ────────────────────────────────────────────────────
#
# ⚠ THESE ARE REAL PEOPLE. The roster below is the studio's actual artists,
# taken from their booking form. The ARTWORK attached to them is not theirs —
# it is machine-drawn placeholder geometry, and every image carries a
# watermark saying so while the kiosk shows a banner over the whole UI. Do not
# remove either safeguard while seed content is in place: real names beside
# fake art is the one way this placeholder data could actually mislead
# somebody, including the artists themselves.
#
# Counts and per-design tags are invented. Only names, handles, seniority and
# listed styles are real.
#
# Pricing is deliberately absent. Kat's minimum spend is recorded in the
# booking form, not here — PRD §6.3 (whether price appears on the kiosk at
# all) is still undecided, and seeding it would quietly make that decision.
#
# Nothing downstream is hardcoded to this list's length. Add or remove entries
# freely; the home screen scrolls and the grid re-flows.

CATEGORIES = [
    "Fine Line",
    "Single Needle",
    "Three Needle",
    "Micro Realism",
    "Realism",
    "Color",
    "Gothic",
    "Abstract",
    "Floral",
    "Large Scale",
]

SENIORITY_OWNER = "Studio Owner"
SENIORITY_SENIOR = "Senior Artist"
SENIORITY_JUNIOR = "Junior Artist"

# Order is the studio's own, owner first. `display_order` follows this list.
ARTISTS = [
    {
        "id": "kat",
        "name": "Kat",
        "handle": "@Kattitudetattoo",
        "seniority": SENIORITY_OWNER,
        "bio": "Large scale work.",
        "count": 12,
        "palette": [PINK, INK],
        "styles": ["Large Scale"],
    },
    {
        "id": "barbie",
        "name": "Barbie",
        "handle": "@delicatelyscripted",
        "seniority": SENIORITY_SENIOR,
        "bio": "Single needle, micro realism, colour and large scale.",
        "count": 9,
        "palette": [INK, PINK],
        "styles": ["Single Needle", "Micro Realism", "Color", "Large Scale"],
    },
    {
        "id": "miranda",
        "name": "Miranda",
        "handle": "@mirandaiink",
        "seniority": SENIORITY_JUNIOR,
        "bio": "Large scale fine line, gothic, abstract and realism.",
        "count": 7,
        "palette": [INK, PINK],
        "styles": ["Large Scale", "Fine Line", "Gothic", "Abstract", "Realism"],
    },
    {
        "id": "jen",
        "name": "Jen",
        "handle": "@inkedbyjemini",
        "seniority": SENIORITY_JUNIOR,
        "bio": "Three needle and single needle work.",
        "count": 5,
        "palette": [PINK, INK],
        "styles": ["Three Needle", "Single Needle"],
    },
    {
        "id": "naomi",
        "name": "Naomi",
        "handle": "@Puratinta_26",
        "seniority": SENIORITY_JUNIOR,
        "bio": "Single needle, three needle, large scale florals.",
        "count": 6,
        "palette": [INK, PINK],
        "styles": ["Single Needle", "Three Needle", "Large Scale", "Floral"],
    },
    {
        "id": "ally",
        "name": "Ally",
        "handle": "@allycat_ink",
        "seniority": SENIORITY_JUNIOR,
        "bio": "Three needle and bolder fine line.",
        "count": 0,
        "palette": [PINK, INK],
        "styles": ["Three Needle", "Fine Line"],
    },
    {
        "id": "alena",
        "name": "Alena",
        "handle": "@Alenanebotattoos",
        "seniority": SENIORITY_SENIOR,
        "bio": "Large scale tattoos and florals.",
        "count": 8,
        "palette": [PINK, INK],
        "styles": ["Large Scale", "Floral"],
    },
]

# ── Sheets ────────────────────────────────────────────────────────────────
# Two kinds live here:
#
#   REAL   — the studio's four existing flash sheets, already in the repo and
#            already on the wall. Only their FILE is real; the artist
#            attribution below is INVENTED, because nobody has told us who
#            drew which sheet. Confirm with the studio before this is treated
#            as fact. It exists so artist galleries can demonstrate the mixed
#            sheet+single layout at all.
#
#   PLACEHOLDER — generated 2160x3840 pages, watermarked like the singles,
#            purely to give the tiling modules enough material to repeat.
#
# The mix is chosen to make every layout state reachable:
#   Kat   — 12 singles + 4 sheets  (mixed, several modules, both alternations)
#   Alena —  8 singles + 3 sheets  (mixed)
#   Ally  —  0 singles + 3 sheets  (SHEETS ONLY -> linear viewer, no grid)
#   others— singles only

REAL_SHEETS = [
    {"id": "sheet-real-1", "title": "Flash Sheet I",
     "file": "assets/sheets/IMG_1705.JPEG", "artist": "kat", "date": "2026-02-14"},
    {"id": "sheet-real-2", "title": "Flash Sheet II",
     "file": "assets/sheets/IMG_2120.JPEG", "artist": "kat", "date": "2026-04-02"},
    {"id": "sheet-real-3", "title": "Flash Sheet III",
     "file": "assets/sheets/Untitled_Artwork.JPEG", "artist": "alena", "date": "2026-03-19"},
    {"id": "sheet-real-4", "title": "Flash Sheet IV",
     "file": "assets/sheets/Untitled_Artwork_2_web.JPEG", "artist": "alena", "date": "2026-05-08"},
]

# (artist_id, count) — generated pages to top up the modules.
PLACEHOLDER_SHEETS = [("kat", 2), ("alena", 1), ("ally", 3)]

SHEET_W, SHEET_H = 2160, 3840   # PRD §4.1 — exact 9:16 for the portrait panel


TITLE_WORDS_A = ["Iron", "Velvet", "Hollow", "Bitter", "Gilded", "Quiet", "Copper",
                 "Salt", "Ash", "Wild", "Paper", "Glass", "Amber", "Low", "Bright"]
TITLE_WORDS_B = ["Crown", "Serpent", "Moth", "Dagger", "Rose", "Anchor", "Lantern",
                 "Wolf", "Key", "Compass", "Sparrow", "Thorn", "Bell", "Tide", "Fox"]


# ── Motif drawing ─────────────────────────────────────────────────────────
# Each design gets one of several geometric motifs, chosen deterministically
# from its index so regenerating produces identical output. These are NOT
# meant to look like tattoo flash — they are meant to be visually distinct
# from each other at thumbnail size, which is what makes a grid layout
# testable. Uniform grey squares would hide exactly the bugs we want to find.

def draw_motif(draw, kind, cx, cy, r, primary, secondary, rng):
    # Pillow >= 10 rejects float coordinates outright, and every call site
    # here derives r from a fraction of the canvas, so normalize once.
    cx, cy, r = int(cx), int(cy), int(r)
    w = max(6, r // 22)

    if kind == 0:  # concentric rings
        for i in range(5):
            rr = int(r * (1 - i * 0.17))
            draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                         outline=primary if i % 2 == 0 else secondary, width=w)

    elif kind == 1:  # radial burst
        spokes = rng.choice([12, 16, 24])
        for i in range(spokes):
            a = (2 * math.pi / spokes) * i
            draw.line([int(cx + math.cos(a) * r * 0.3), int(cy + math.sin(a) * r * 0.3),
                       int(cx + math.cos(a) * r), int(cy + math.sin(a) * r)],
                      fill=primary, width=w)
        draw.ellipse([int(cx - r * 0.3), int(cy - r * 0.3), int(cx + r * 0.3), int(cy + r * 0.3)],
                     outline=secondary, width=w * 2)

    elif kind == 2:  # nested polygons
        for i, sides in enumerate([3, 5, 7]):
            rr = int(r * (1 - i * 0.25))
            pts = [(int(cx + math.cos(2 * math.pi * s / sides - math.pi / 2) * rr),
                    int(cy + math.sin(2 * math.pi * s / sides - math.pi / 2) * rr))
                   for s in range(sides)]
            draw.polygon(pts, outline=primary if i % 2 == 0 else secondary, width=w)

    elif kind == 3:  # crescent
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=primary, width=w * 2)
        off = r * 0.45
        draw.ellipse([int(cx - r + off), int(cy - r - off * 0.2),
                      int(cx + r + off), int(cy + r - off * 0.2)], outline=secondary, width=w)

    elif kind == 4:  # lattice
        step = r // 4
        for i in range(-4, 5):
            draw.line([cx + i * step, cy - r, cx + i * step, cy + r], fill=primary, width=w // 2 or 1)
            draw.line([cx - r, cy + i * step, cx + r, cy + i * step], fill=secondary, width=w // 2 or 1)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=primary, width=w * 2)

    elif kind == 5:  # star
        pts = []
        for i in range(16):
            a = math.pi * i / 8 - math.pi / 2
            rr = r if i % 2 == 0 else r * 0.42
            pts.append((int(cx + math.cos(a) * rr), int(cy + math.sin(a) * rr)))
        draw.polygon(pts, outline=primary, width=w)
        draw.ellipse([int(cx - r * 0.2), int(cy - r * 0.2), int(cx + r * 0.2), int(cy + r * 0.2)], fill=secondary)

    elif kind == 6:  # arcs stack
        for i in range(6):
            rr = int(r * (1 - i * 0.14))
            start = rng.randint(0, 180)
            draw.arc([cx - rr, cy - rr, cx + rr, cy + rr],
                     start, start + rng.randint(140, 300),
                     fill=primary if i % 2 == 0 else secondary, width=w)

    else:  # interlocking diamonds
        for i, off in enumerate([(-r * 0.28, 0), (r * 0.28, 0), (0, -r * 0.28)]):
            rr = r * 0.62
            ox, oy = off
            draw.polygon([(int(cx + ox), int(cy + oy - rr)), (int(cx + ox + rr), int(cy + oy)),
                          (int(cx + ox), int(cy + oy + rr)), (int(cx + ox - rr), int(cy + oy))],
                         outline=primary if i % 2 == 0 else secondary, width=w)


def render_design(design, artist, index):
    """2048x2048 transparent PNG, motif + label block."""
    rng = random.Random(f"{design['id']}::{index}")
    img = Image.new("RGBA", (DESIGN_PX, DESIGN_PX), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    primary, secondary = artist["palette"]
    cx = cy = DESIGN_PX // 2

    # Variety matters more than it sounds: reviewing a grid where several
    # tiles are visually identical makes it impossible to tell a layout bug
    # from a duplicate. `index % 8` repeated the same motif every eighth
    # design with near-identical parameters. Derive the motif from a hash of
    # the id instead, and vary scale, rotation and a second overlaid motif so
    # no two designs read the same.
    seed_int = int(hashlib.md5(design["id"].encode()).hexdigest()[:8], 16)
    kind = seed_int % 8
    alt = (seed_int >> 3) % 8
    if alt == kind:
        alt = (alt + 3) % 8

    scale = 0.26 + (seed_int % 7) * 0.018          # 0.26 .. 0.37
    off_x = ((seed_int >> 6) % 5 - 2) * (DESIGN_PX // 22)
    off_y = ((seed_int >> 9) % 5 - 2) * (DESIGN_PX // 26)

    layer = Image.new("RGBA", (DESIGN_PX, DESIGN_PX), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    draw_motif(ld, kind, cx + off_x, cy - 90 + off_y, DESIGN_PX * scale,
               primary, secondary, rng)
    # A second, smaller motif offset from the first — this is what stops two
    # designs sharing a base shape from looking like the same drawing.
    draw_motif(ld, alt, cx - off_x, cy - 90 - off_y, DESIGN_PX * scale * 0.52,
               secondary, primary, rng)
    layer = layer.rotate(((seed_int >> 12) % 8) * 45 * 0.25, resample=Image.BICUBIC,
                         center=(cx, cy - 90))
    img.alpha_composite(layer)

    # Label block — makes each tile identifiable while scanning a grid, which
    # is the whole point of placeholder art.
    title_font = load_font(132)
    meta_font = load_font(76)
    tag_font = load_font(60)

    def centered(text, font, y, fill):
        bbox = d.textbbox((0, 0), text, font=font)
        d.text(((DESIGN_PX - (bbox[2] - bbox[0])) / 2, y), text, font=font, fill=fill)

    centered(design["title"].upper(), title_font, DESIGN_PX - 560, INK)
    centered(artist["handle"], meta_font, DESIGN_PX - 390, primary)
    centered(" • ".join(design["categories"]), tag_font, DESIGN_PX - 280, (26, 26, 26, 140))

    # Unmissable placeholder watermark. Without this, seed art in a screenshot
    # is indistinguishable from real flash and someone will eventually ship it.
    wm_font = load_font(54)
    wm = "SEED PLACEHOLDER — NOT REAL FLASH"
    bbox = d.textbbox((0, 0), wm, font=wm_font)
    d.text(((DESIGN_PX - (bbox[2] - bbox[0])) / 2, 120), wm, font=wm_font, fill=(233, 30, 140, 110))

    png_path = os.path.join(DESIGN_DIR, f"{design['id']}.png")
    img.save(png_path, "PNG", compress_level=6)

    thumb = img.resize((THUMB_PX, THUMB_PX), Image.LANCZOS)
    thumb.save(os.path.join(THUMB_DIR, f"{design['id']}.webp"), "WEBP", quality=86, method=4)


def render_portrait(artist, index):
    """Dark-ground portrait. The artist cards are black, so a light portrait
    read as a bright hole punched in the card. Yellow finally works here —
    13.6:1 against this background."""
    rng = random.Random(artist["id"])
    img = Image.new("RGBA", (PORTRAIT_PX, PORTRAIT_PX), (26, 26, 26, 255))
    d = ImageDraw.Draw(img)
    accent = YELLOW if index % 2 == 0 else PINK
    second = PINK if accent is YELLOW else YELLOW
    draw_motif(d, index % 8, PORTRAIT_PX // 2, PORTRAIT_PX // 2, PORTRAIT_PX * 0.32,
               accent, second, rng)

    initials = "".join(p[0] for p in artist["name"].split()[:2]).upper()
    font = load_font(300)
    bbox = d.textbbox((0, 0), initials, font=font)
    d.text(((PORTRAIT_PX - (bbox[2] - bbox[0])) / 2,
            (PORTRAIT_PX - (bbox[3] - bbox[1])) / 2 - bbox[1]),
           initials, font=font, fill=(255, 255, 255, 255))
    img.save(os.path.join(PORTRAIT_DIR, f"{artist['id']}.png"), "PNG", compress_level=6)


def render_sheet(sheet_id, artist, index):
    """A generated flash SHEET — 2160x3840, a page of many small motifs rather
    than one big one. Composed differently from a single on purpose: at
    thumbnail size a sheet has to be instantly distinguishable from a single
    design, or the mixed grid reads as noise."""
    rng = random.Random(sheet_id)
    img = Image.new("RGBA", (SHEET_W, SHEET_H), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)

    cols, rows = 3, 5
    cell_w = SHEET_W // cols
    cell_h = (SHEET_H - 620) // rows
    for r in range(rows):
        for c in range(cols):
            cx = c * cell_w + cell_w // 2
            cy = 420 + r * cell_h + cell_h // 2
            colour = PINK if (r + c) % 2 == 0 else INK
            second = INK if colour is PINK else PINK
            draw_motif(d, (r * cols + c + index) % 8, cx, cy,
                       min(cell_w, cell_h) * 0.36, colour, second, rng)

    title_font = load_font(150)
    meta_font = load_font(84)
    wm_font = load_font(64)

    def centred(text, font, y, fill):
        bbox = d.textbbox((0, 0), text, font=font)
        d.text(((SHEET_W - (bbox[2] - bbox[0])) / 2, y), text, font=font, fill=fill)

    centred("SEED PLACEHOLDER — NOT REAL FLASH", wm_font, 150, (233, 30, 140, 160))
    centred(f"{artist['name'].upper()} — FLASH SHEET", title_font, 240, INK)
    centred(artist["handle"], meta_font, SHEET_H - 280, PINK)

    img.save(os.path.join(DESIGN_DIR, f"{sheet_id}.png"), "PNG", compress_level=6)

    # Sheet thumbs keep the 9:16 shape — squashing them square in the grid
    # would hide the composition that makes a sheet a sheet.
    thumb = img.resize((THUMB_PX, int(THUMB_PX * SHEET_H / SHEET_W)), Image.LANCZOS)
    thumb.save(os.path.join(THUMB_DIR, f"{sheet_id}.webp"), "WEBP", quality=86, method=4)


def measure(rel_path):
    """Actual pixel dimensions. The four real sheets are NOT the 9:16 the PRD
    specifies — they are 0.79, 0.82, 0.77 and one dead square — so the grid
    cannot assume a shape. Recording real dimensions lets each sheet claim a
    block that matches it instead of being cropped to fit a guess."""
    full = os.path.join(ROOT, rel_path)
    try:
        with Image.open(full) as im:
            return im.size
    except OSError:
        return (None, None)


def build_sheets():
    """Catalog entries for both the real sheets and the generated ones."""
    by_id = {a["id"]: a for a in ARTISTS}
    out = []

    for order, s in enumerate(REAL_SHEETS):
        w, h = measure(s["file"])
        out.append({
            "width": w, "height": h,
            "id": s["id"],
            "artistId": s["artist"],
            "title": s["title"],
            "categories": [],
            "type": "sheet",
            # Real file, already in the repo. No thumb derivative exists yet —
            # the full JPEG stands in, which is exactly the CDN-transform gap
            # called out in the PRD §4.1 notes.
            "image": s["file"],
            "thumb": s["file"],
            "featured": False,
            "published": True,
            "approved": True,
            "displayOrder": order,
            "createdAt": s["date"],
            "placeholder": False,
        })

    rng = random.Random(913)
    for artist_id, count in PLACEHOLDER_SHEETS:
        artist = by_id[artist_id]
        for i in range(count):
            sid = f"seed-sheet-{artist_id}-{i + 1:02d}"
            out.append({
                "width": SHEET_W, "height": SHEET_H,
                "id": sid,
                "artistId": artist_id,
                "title": f"{artist['name']} Flash Sheet {i + 1}",
                "categories": artist["styles"][:1],
                "type": "sheet",
                "image": f"assets/seed/designs/{sid}.png",
                "thumb": f"assets/seed/thumbs/{sid}.webp",
                "featured": False,
                "published": True,
                "approved": True,
                "displayOrder": len(REAL_SHEETS) + i,
                "createdAt": f"2026-{rng.randint(1, 7):02d}-{rng.randint(1, 28):02d}",
                "placeholder": True,
            })
    return out


def build_catalog():
    rng = random.Random(20260801)
    designs = []
    counter = 0

    for artist in ARTISTS:
        for i in range(artist["count"]):
            counter += 1
            did = f"seed-{artist['id']}-{i + 1:02d}"
            n_cats = rng.choice([1, 1, 2, 2, 3])
            cats = rng.sample(artist["styles"], min(n_cats, len(artist["styles"])))
            title = f"{rng.choice(TITLE_WORDS_A)} {rng.choice(TITLE_WORDS_B)}"
            designs.append({
                "id": did,
                "width": DESIGN_PX, "height": DESIGN_PX,
                "artistId": artist["id"],
                "title": title,
                "categories": cats,
                "type": "design",
                "image": f"assets/seed/designs/{did}.png",
                "thumb": f"assets/seed/thumbs/{did}.webp",
                "featured": rng.random() < 0.12,
                "published": True,
                "approved": True,
                "displayOrder": i,
                "createdAt": f"2026-{rng.randint(1, 7):02d}-{rng.randint(1, 28):02d}",
            })
    return designs


def write_seed_js(designs, sheets):
    payload = {
        "generatedAt": "tools/generate-seed.py",
        # Tells catalog.js that this source already supplies sheets, so it must
        # NOT also append the raw unattributed list from data.js — that would
        # duplicate all four real sheets.
        "providesSheets": True,
        "artists": [
            {
                "id": a["id"], "name": a["name"], "handle": a["handle"],
                "bio": a["bio"],
                # Real, and derived rather than typed twice — the handle is the
                # single source of truth. Stored as a full URL so the kiosk
                # never has to know how to build one, and so the dashboard can
                # later override it for an artist whose socials move.
                "instagram": "https://instagram.com/" + a["handle"].lstrip("@"),
                # Real. Carried through so card ordering can key off it later
                # without another data pass. Not rendered on the kiosk by
                # default — see KIOSK_CONFIG.showSeniority.
                "seniority": a["seniority"],
                "portrait": f"assets/seed/artists/{a['id']}.png",
                "displayOrder": i, "active": True,
            }
            for i, a in enumerate(ARTISTS)
        ],
        "categories": [{"id": c.lower().replace(" ", "-"), "name": c, "displayOrder": i}
                       for i, c in enumerate(CATEGORIES)],
        "designs": designs + sheets,
    }
    os.makedirs(os.path.dirname(SEED_DATA_JS), exist_ok=True)
    with open(SEED_DATA_JS, "w") as f:
        f.write("/* GENERATED FILE — do not edit by hand.\n"
                " * Produced by tools/generate-seed.py. Placeholder content only:\n"
                " * fake artists, fake designs, machine-drawn art. Delete this file\n"
                " * and assets/seed/ once real flash is cut and a live catalog\n"
                " * source is configured in config.js.\n"
                " */\n")
        f.write("window.SEED_CATALOG = ")
        json.dump(payload, f, indent=2)
        f.write(";\n")


def clean():
    for path in (SEED_ASSETS, os.path.dirname(SEED_DATA_JS)):
        if os.path.isdir(path):
            shutil.rmtree(path)
            print(f"removed {os.path.relpath(path, ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true", help="delete generated seed output")
    args = ap.parse_args()

    if args.clean:
        clean()
        return

    for p in (DESIGN_DIR, THUMB_DIR, PORTRAIT_DIR):
        os.makedirs(p, exist_ok=True)

    designs = build_catalog()
    sheets = build_sheets()

    for i, artist in enumerate(ARTISTS):
        render_portrait(artist, i)
    for i, design in enumerate(designs):
        artist = next(a for a in ARTISTS if a["id"] == design["artistId"])
        render_design(design, artist, i)
    for i, sheet in enumerate(sheets):
        if not sheet.get("placeholder"):
            continue   # real sheets already exist on disk
        artist = next(a for a in ARTISTS if a["id"] == sheet["artistId"])
        render_sheet(sheet["id"], artist, i)

    write_seed_js(designs, sheets)
    generated = sum(1 for s in sheets if s.get("placeholder"))
    print(f"{len(designs)} designs, {len(sheets)} sheets "
          f"({generated} generated, {len(sheets) - generated} real), "
          f"{len(ARTISTS)} artists, {len(CATEGORIES)} categories")
    print(f"wrote {os.path.relpath(SEED_DATA_JS, ROOT)} and assets/seed/")


if __name__ == "__main__":
    main()
