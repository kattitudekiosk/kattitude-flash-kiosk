#!/usr/bin/env python3
"""Decode the QR codes the kiosk actually rendered.

Reads the JSON dump from tools/verify-qr.js on stdin, rasterises each code's
real SVG markup with cairosvg, and decodes the bitmap with OpenCV — an
implementation completely independent of the qrcode.js the kiosk encodes with.
That independence is the point: a round trip through the same library would
happily agree with itself about a wrong payload.

This used to rebuild a module matrix by re-parsing "M<x>,<y>h1v1h-1z" subpaths
out of the SVG path data. That check died the moment the modules were rounded,
and it was the weaker check anyway — it verified what we MEANT to draw.
Rasterising the actual markup tests what a camera would see: rounded modules,
rounded finder patterns, the quiet zone, the error correction level, all of it.

    node tools/verify-qr.js | python3 tools/verify-qr.py

Requires: opencv-python-headless, cairosvg, numpy.
"""

import json
import sys

import cairosvg
import cv2
import numpy as np

# Every surface a code ships on, at its true size: the badge's CSS box and the
# white padding that forms its quiet zone. A code has to survive at the
# SMALLEST size it ships at, so the artist card is the one that matters.
# 68.8 ppi is 1080 design px across ~15.7in of glass on a 32" panel rotated.
PPI = 68.8
SURFACES = [
    ("detail panel", 260, 28),
    ("artist card", 180, 19),
    ("sheet corner", 138, 15),
]
EXPECTED_GALLERY_URL = "https://kattitude-flash-kiosk.vercel.app"   # Kat's Vercel
SCALE = 4   # oversample, so the decode tests the shape rather than one AA pass


def rasterise(svg_markup, box_px, pad_px):
    """Render the SVG onto a white tile with its real padding as quiet zone."""
    code_px = box_px - 2 * pad_px
    png = cairosvg.svg2png(
        bytestring=svg_markup.encode("utf-8"),
        output_width=code_px * SCALE,
        output_height=code_px * SCALE,
        background_color="white",
    )
    code = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)

    pad = pad_px * SCALE
    tile = np.full((code.shape[0] + 2 * pad, code.shape[1] + 2 * pad), 255, np.uint8)
    tile[pad:pad + code.shape[0], pad:pad + code.shape[1]] = code
    return tile


def main():
    data = json.load(sys.stdin)
    codes = data["codes"]
    scoping = data.get("scoping", {})
    detector = cv2.QRCodeDetector()
    failures = []

    print(f"decoding {len(codes)} QR codes rendered by the kiosk")
    print("rasterised from the real SVG at each surface's true pixel size\n")

    for entry in codes:
        name = entry.get("artist", "?")
        if "error" in entry:
            failures.append(f"{name}: {entry['error']}")
            print(f"  FAIL {name:<9} {entry['error']}")
            continue

        expected = entry["expected"]
        n = entry["size"]

        # The label under the code must name the same account the code points
        # at — a mismatch here sends someone to the wrong artist. The corner
        # caption reads "Follow @handle"; the inline panel is just "@handle".
        handle_in_url = expected.rsplit("/", 1)[-1].lower()
        label = (entry.get("label") or "").replace("Follow", "").strip().lstrip("@").lower()
        label_ok = label == handle_in_url
        if not label_ok:
            failures.append(f"{name}: label {label!r} does not name {handle_in_url!r}")

        print(f"  {name:<9} {n}x{n} modules -> {expected}")
        for surface, box, pad in SURFACES:
            img = rasterise(entry["svg"], box, pad)
            decoded, _, _ = detector.detectAndDecode(img)
            good = decoded == expected
            mm = (box - 2 * pad) / PPI * 25.4 / n
            quiet = pad / ((box - 2 * pad) / n)
            line = (f"      {'ok  ' if good else 'FAIL'} {surface:<13}"
                    f" {box}px badge  {mm:.2f}mm/module  quiet {quiet:.1f} modules")
            if not good:
                line += f"  -> {decoded or '<undecodable>'}"
                failures.append(
                    f"{name} @ {surface}: decoded {decoded!r}, expected {expected!r}")
            if quiet < 4:
                line += "  QUIET ZONE UNDER SPEC"
                failures.append(f"{name} @ {surface}: quiet zone {quiet:.1f} < 4 modules")
            print(line)
        if not label_ok:
            print(f"      FAIL label {label!r} != {handle_in_url!r}")

    # The studio-wide "Browse on your phone" codes. They must decode to the
    # phone gallery, and config.js must name Kat's address — a code that
    # faithfully encodes a retired URL is still a broken code on the wall.
    studio = data.get("studio", [])
    gallery_url = data.get("galleryUrl")
    print(f"\nbrowse-on-your-phone codes ({len(studio)}) -> {gallery_url}")
    if gallery_url != EXPECTED_GALLERY_URL:
        failures.append(f"config.js galleryUrl is {gallery_url!r}, expected {EXPECTED_GALLERY_URL!r}")
        print(f"  FAIL galleryUrl is {gallery_url!r}, expected {EXPECTED_GALLERY_URL!r}")
    if len(studio) < 2:
        failures.append(f"expected 2 browse-on-your-phone codes, got {len(studio)}")
    for entry in studio:
        name = entry.get("artist", "?")
        if "error" in entry:
            failures.append(f"{name}: {entry['error']}")
            print(f"  FAIL {name}: {entry['error']}")
            continue
        if (entry.get("label") or "").strip() != "Browse on your phone":
            failures.append(f"{name}: caption {entry.get('label')!r}")
        img = rasterise(entry["svg"], entry["cssPx"], entry["padPx"])
        decoded, _, _ = detector.detectAndDecode(img)
        good = decoded == EXPECTED_GALLERY_URL
        print(f"  {'ok  ' if good else 'FAIL'} {name:<26} {entry['cssPx']}px  -> {decoded or '<undecodable>'}")
        if not good:
            failures.append(f"{name}: decoded {decoded!r}, expected {EXPECTED_GALLERY_URL!r}")

    # The artist cards on the Artists index carry their own, separately drawn
    # code. Decode those — not the follow panel's code re-rasterised small.
    cards = data.get("cards", [])
    print(f"\nartist-card codes on the Artists index ({len(cards)})")
    if not cards:
        failures.append("no artist-card codes found on the Artists index")
    for entry in cards:
        name = entry.get("artist", "?")
        if "error" in entry:
            failures.append(f"{name}: {entry['error']}")
            print(f"  FAIL {name}: {entry['error']}")
            continue
        decoded, _, _ = detector.detectAndDecode(
            rasterise(entry["svg"], entry["cssPx"], entry["padPx"]))
        good = decoded == entry["expected"]
        print(f"  {'ok  ' if good else 'FAIL'} {name:<14} -> {decoded or '<undecodable>'}")
        if not good:
            failures.append(f"{name}: decoded {decoded!r}, expected {entry['expected']!r}")

    print("\nscoping")
    for key, msg in [
        ("artistsIndexHasStrayBadge", "Artists index carries no stray studio/follow badge"),
        ("homeHasQr", "home screen carries no artist QR"),
        ("studioGridHasQr", "studio-wide grid carries no artist QR"),
        ("tilesHaveQr", "grid tiles carry no QR"),
    ]:
        bad = scoping.get(key)
        print(f"  {'FAIL' if bad else 'ok  '} {msg}")
        if bad:
            failures.append(msg)

    if failures:
        print(f"\n{len(failures)} FAILURES")
        for f in failures:
            print("  - " + f)
        sys.exit(1)

    print(f"\nall {len(codes)} codes decode to the correct profile at every size")


if __name__ == "__main__":
    main()
