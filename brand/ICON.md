# Club Votes icon

The mark: a black ballot box with a cream slot, with three raised hands
(a centre hand and one on each side, each with a small thumb) peeking
over the top edge. One silhouette, flat shapes, no text, drawn to read
at 32 px.

## Files

| File | Size | Use |
| --- | --- | --- |
| `icon.svg` | 1024×1024 viewBox | Source of the app icon |
| `icon.png` | 1024×1024, opaque | The app icon, set as `icon.image` in `dapp.json` |
| `featured-light.svg` / `featured-light.png` | 1600×900 | Featured illustration, light look: black mark on cream, three voting slips (yellow, blue, green) with black outlines drifting toward the slot |
| `featured-dark.svg` / `featured-dark.png` | 1600×900 | Featured illustration, dark look: cream mark on black, the same slips with no outline |

`icon.emoji` (🗳️) stays in `dapp.json` as the fallback if the image
cannot be loaded or fails validation.

## Palette

Only Homeroom brand colours, in the brand pairings:

- Cream `#FFFEEA` — the tile ground (light featured ground, dark featured mark)
- Black `#000000` — the mark, the slip outlines and ticks, dark featured ground
- Yellow `#FFEE6F`, Blue `#3090E1`, Green `#A9CF97` — the voting slips (featured icons only)

No gradients, shadows, opacity or text. The only other pixel values in
the PNGs are anti-aliased edges between two neighbouring palette colours.

## Re-rendering

The SVG sources are the source of truth; the PNGs are rendered once at
their exact declared size. Render with a headless browser viewport
matching each SVG's size, for example:

```sh
npx playwright screenshot --viewport-size=1024,1024 brand/icon.svg brand/icon.png
npx playwright screenshot --viewport-size=1600,900 brand/featured-light.svg brand/featured-light.png
npx playwright screenshot --viewport-size=1600,900 brand/featured-dark.svg brand/featured-dark.png
```

Each PNG must stay at 256 KB or less (they are far under it).

## Featured icon

The platform conventions describe no `dapp.json` field for a featured or
directory image, so `featured-light.*` and `featured-dark.*` are
committed here but not referenced from `dapp.json`. They wait for a
platform field; wire them in once one exists, rather than inventing a
setting.
