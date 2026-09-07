# Brand assets

Source of truth for the Helmryth mark. Everything here is SVG; the raster icons
under `build/` are generated from `helmryth-tile.svg` by `pnpm build:icons` and
should never be edited by hand.

| File | Use |
|---|---|
| `helmryth-mark.svg` | The mark alone, transparent. Web, favicons, anywhere a bare glyph is wanted. |
| `helmryth-mark-mono.svg` | Same geometry, `currentColor`. Inherits the surrounding text colour. |
| `helmryth-tile.svg` | The app tile — mark on warm paper inside the clipped octagon. Master for every generated icon. |
| `helmryth-lockup.svg` | Mark and wordmark, for headers and READMEs. |

## The mark

A run line, halted at a notch, with a hand-set arm seated in it.

The thin petrol rule is work running. The heavy vermilion arm is a person set into
that run at an angle nothing automatic would have chosen. The notch holds the
setting so it cannot drift. It is the product's one claim drawn as a shape:
nothing runs until you answer.

## Colour

| Token | Hex | Meaning |
|---|---|---|
| Vermilion | `#C44F36` | Command — the human act. Never decorative. |
| Petrol | `#167A78` | Live signal — work in motion. |
| Paper | `#F6F1E7` | Surface. |
| Rule | `#D6CAB9` | Structure. |
| Ink | `#273447` | Type. |

That vermilion/petrol split is load-bearing: the application uses the same two
colours for the same two meanings. A mark that swapped them would fight the UI.

## Rules

The mark must read in one colour before it reads in two — use
`helmryth-mark-mono.svg` to check. Do not recolour it, rotate it, add a glow or a
gradient, place it on a busy photograph, or set the wordmark in a different
typeface. The wordmark is Atkinson Hyperlegible Next, the same face the product
uses, chosen because legibility is a product principle rather than a style.

## Raster exports

GitHub accepts only PNG, GIF or JPG for avatars and social previews, so `png/`
carries rendered copies. They are generated from the SVGs above — if the mark
changes, regenerate rather than edit.

| File | Use |
|---|---|
| `png/helmryth-avatar-1024.png` | Organisation and repository avatar. Full-bleed paper; GitHub rounds the corners itself. |
| `png/helmryth-avatar-512.png` | Smaller avatar slots. |
| `png/helmryth-avatar-256.png` | Anywhere a small square is wanted. |
| `png/helmryth-social-1280x640.png` | Repository social preview — the card that renders when the repo is linked. |

The avatar is full-bleed rather than the clipped octagon on purpose: GitHub masks
avatars to a rounded square, and a transparent octagon inside that mask reads as a
mistake. The mark sits well inside the circular safe area — its furthest point is
403px from centre against a 512px radius — so nothing is lost to any crop.
