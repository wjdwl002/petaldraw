// Render several seeds side by side into one SVG for review.
//   node tools/sheet.js rose lily 42 daisy > sheet.svg
//   node tools/sheet.js --count 12 > sheet.svg      (seeds 1..12)
// Options: --cols N (default 3), --mono (lines only), --bare (no "seed …" captions)
const fd = require('../flowerdraw.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const value = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const valued = new Set(['--count', '--cols']);

let seeds = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
if (value('count')) seeds = Array.from({ length: Number(value('count')) }, (_, i) => String(i + 1));
const cols = Math.min(Number(value('cols') || process.env.COLS || 3), seeds.length);

const W = 600, H = 720, S = 0.5;
const cells = seeds.map((seed, i) => {
  const res = fd.generate(seed, { color: !flag('mono') });
  const inner = res.svg.replace(/^<svg[^>]*>\n/, '').replace(/<\/svg>$/, '');
  const x = (i % cols) * W * S, y = Math.floor(i / cols) * H * S;
  const caption = flag('bare') ? '' : `<text x="12" y="28" font-family="monospace" font-size="18" fill="#888">seed ${seed}</text>`;
  return `<g transform="translate(${x} ${y}) scale(${S})">${inner}${caption}</g>`;
});
const rows = Math.ceil(seeds.length / cols);
process.stdout.write(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * W * S}" height="${rows * H * S}" viewBox="0 0 ${cols * W * S} ${rows * H * S}">\n${cells.join('\n')}\n</svg>\n`
);
