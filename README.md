# petaldraw

Procedurally generated botanical flowers, drawn like a vintage engraving.
Inspired by Lingdong Huang's [fishdraw](https://github.com/LingDong-/fishdraw).

Every seed grows one flower, and the same seed always grows the same one. Each
flower starts from a botanical floral formula (e.g. `⊕ K5 C5 A∞ G̲(3)`), which
sets its petal count, symmetry and structure. It is then drawn as single-stroke
line art, with veined petals, stamens and pistil, and pastel color, and gets an
invented Latin name.

![Nine generated flowers](docs/gallery.svg)

## Usage

No dependencies, no install.

**Browser:** open `index.html`. Type a seed or press **R** for a random one.

**Command line** (Node):

```sh
node petaldraw.js --seed rose > rose.svg      # one flower
node petaldraw.js --seed rose --mono > r.svg  # line art only, for pen plotters
node petaldraw.js --seed rose --genome        # the flower's parameters as JSON
node tools/sheet.js 1 2 3 rose > sheet.svg    # several flowers on one sheet
```

**Library:**

```js
const petaldraw = require('./petaldraw.js'); // or <script src="petaldraw.js">
const { genome, svg } = petaldraw.generate('rose', { color: true });
```

## How it works

1. **Genome:** a seeded random generator builds the floral formula, then the
   flower from it: rings of petals and sepals (length, width, tip shape, cup,
   curl), stamens and pistil.
2. **Geometry:** petal outlines are Bézier curves, bent into 3D and projected
   from a tilted viewpoint.
3. **Detail:**
   - **Petals:** veins follow each petal's width and bend with it, and short
     hatch strokes shade the base.
   - **Center:** stamens and a pistil that match the formula, or for daisy-type
     heads, a disc of florets placed by the golden angle.
4. **Hidden lines:** nearer parts hide the lines behind them, so the SVG is
   clean single-stroke paths.
5. **Color:** pastel gradients are painted under the ink. `--mono` turns them
   off.

For plotting, outlines and fine detail are in separate SVG groups (`drawing`
and `detail`), so each can use its own pen.

## Roadmap

- [x] Flower head: petals, tip shapes, symmetry, color
- [x] Flower center: stamens, pistil, golden-angle florets
- [x] Petal veins and base shading
- [ ] Stems and leaves
- [ ] Inflorescences: raceme, umbel, spike, panicle
- [ ] Shading: cross-hatching and stippling that follow the surface
- [ ] Full botanical plate with dissections and labels
