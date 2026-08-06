#!/usr/bin/env bash
# Deploy a PREVIEW build to Vercel.
#
#   bash tools/deploy-preview.sh
#
# Ships to the `flash-gallery-preview` project. The live kiosk site
# (flash-gallery.vercel.app) is a DIFFERENT project and is never touched by
# this script — there is no --prod flag anywhere in it, and it deploys from a
# directory named flash-gallery-preview so Vercel cannot link it to the live
# project by name.
#
# Why the copy: Vercel names a new project after the directory it deploys
# from. Running this from ~/flash-gallery would match the live project's name
# and link to it. The copy makes the target unambiguous.

set -euo pipefail

SRC="$HOME/flash-gallery"
STAGE="/tmp/flash-gallery-preview"
TEAM="team_mb29bMintz7Ffd29VRICdhGx"

echo "==> staging a clean copy"
rm -rf "$STAGE"
cp -R "$SRC" "$STAGE"
# .git carries the whole history and .vercel would re-link to a stale project.
rm -rf "$STAGE/.git" "$STAGE/.vercel"

# .vercelignore must come along, or Vercel falls back to .gitignore — which
# excludes assets/seed/ and seed/, and every placeholder image would be
# stripped out, leaving a gallery of broken tiles.
if [ ! -f "$STAGE/.vercelignore" ]; then
  echo "!! .vercelignore missing — seed images would be stripped. Aborting." >&2
  exit 1
fi

echo "==> deploying preview"
cd "$STAGE"
npx --yes vercel@latest deploy --yes --scope "$TEAM"

echo
echo "Live kiosk site is untouched: https://flash-gallery.vercel.app"
