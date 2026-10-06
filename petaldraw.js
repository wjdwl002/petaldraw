/*
 * petaldraw — procedural botanical flowers in a pen-plotter / engraving style.
 * Inspired by Lingdong Huang's fishdraw.
 *
 * Single file, no dependencies. Works in the browser (<script src>) and in Node:
 *   node petaldraw.js --seed "Rosa" > rosa.svg
 *   node petaldraw.js --seed 42 --genome        (print the genome as JSON)
 *   node petaldraw.js --seed 42 --mono          (lines only, for pen plotters)
 *
 * Pipeline:  seed -> genome (floral formula first, then morphology) -> parts -> occlusion -> SVG
 *
 * Every anatomical part emits "items": { depth, outline, strokes }.
 *   outline  closed screen-space polygon; hides lines of items drawn after it
 *   strokes  screen-space polylines (the only thing that ends up in the SVG)
 * Items are processed nearest-first; each item's strokes are clipped against the
 * outlines of all nearer items. The linework never uses fills; an optional pastel
 * color layer is painted underneath it from the same outlines (off with color: false).
 */
(function (root) {
  'use strict';

  var TAU = Math.PI * 2;
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5 deg, used from step 2 on

  // ------------------------------------------------------------------ PRNG

  // cyrb128: string -> four 32-bit hashes
  function hash128(str) {
    var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (var i = 0; i < str.length; i++) {
      var k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  // One independent stream per (seed, name). Each genome section and each
  // drawing pass gets its own stream, so adding genes to one section later
  // does not change the random numbers any other section receives.
  function makeRng(seed, stream) {
    var h = hash128(String(seed) + '\u0000' + stream);
    var next = sfc32(h[0], h[1], h[2], h[3]);
    for (var i = 0; i < 12; i++) next();
    var r = {
      next: next,
      range: function (a, b) { return a + (b - a) * next(); },
      int: function (a, b) { return Math.floor(a + (b - a + 1) * next()); },
      chance: function (p) { return next() < p; },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      // table: [[value, weight], ...]
      weighted: function (table) {
        var total = 0, i;
        for (i = 0; i < table.length; i++) total += table[i][1];
        var x = next() * total;
        for (i = 0; i < table.length; i++) { x -= table[i][1]; if (x < 0) return table[i][0]; }
        return table[table.length - 1][0];
      },
      gauss: function (mean, sd) {
        var u = 1 - next(), v = next();
        return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
      },
    };
    return r;
  }

  // ------------------------------------------------------------------ math helpers

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function round2(x) { return Math.round(x * 100) / 100; }

  function cubicPts(p0, p1, p2, p3, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
    return out;
  }

  // Append src to dst, dropping src[0] when it duplicates dst's last point.
  function append(dst, src) {
    for (var i = dst.length ? 1 : 0; i < src.length; i++) dst.push(src[i]);
    return dst;
  }

  function resample(pts, step) {
    if (pts.length < 2) return pts.slice();
    var out = [pts[0]], carry = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      var d = step - carry;
      while (d <= len) {
        out.push([a[0] + dx * d / len, a[1] + dy * d / len]);
        d += step;
      }
      carry = len - (d - step);
    }
    var last = pts[pts.length - 1], tail = out[out.length - 1];
    if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push(last);
    else out[out.length - 1] = last;
    return out;
  }

  // ------------------------------------------------------------------ genome: floral formula

  // The formula is generated first; everything else is drawn from it.
  //   K calyx (sepals), C corolla (petals), P perianth of tepals, A androecium (stamens),
  //   G gynoecium (carpels). fused = connate, n = Infinity means "many".
  function genFormula(r) {
    if (r.chance(0.14)) {
      // Composite head (Asteraceae-like). The formula describes one disc floret.
      return {
        capitulum: true, merosity: 5, symmetry: 'actinomorphic', perianth: 'differentiated',
        K: { n: 0, fused: false }, C: { n: 5, whorls: 1, fused: true }, P: null,
        A: { n: 5, fused: true, epipetalous: true },
        G: { n: 2, fused: true, position: 'inferior' },
      };
    }
    var m = r.weighted([[3, 30], [4, 14], [5, 46], [6, 10]]);
    var symmetry = m >= 4 && r.chance(0.24) ? 'zygomorphic' : 'actinomorphic';
    var tepals = m === 3 && r.chance(0.65);
    var doubled = !tepals && r.chance(0.18);
    var f = { capitulum: false, merosity: m, symmetry: symmetry, perianth: tepals ? 'tepals' : 'differentiated' };
    f.K = tepals ? null : { n: m, fused: r.chance(0.3) };
    f.P = tepals ? { n: m, whorls: 2, fused: false } : null;
    f.C = tepals ? null : { n: m, whorls: doubled ? r.int(2, 5) : 1, fused: !doubled && r.chance(0.25) };
    var a = r.weighted([[m, 40], [2 * m, 30], [Infinity, 30]]);
    if (symmetry === 'zygomorphic' && a === m && r.chance(0.5)) a = m - 1; // one stamen reduced to a staminode
    f.A = { n: a, fused: false, epipetalous: !!(f.C && f.C.fused) && r.chance(0.7) };
    var g = r.weighted([[1, 10], [2, 20], [3, 30], [5, 15], [m, 15], [Infinity, 10]]);
    f.G = { n: g, fused: g > 1 && g !== Infinity && r.chance(0.75), position: r.chance(0.7) ? 'superior' : 'inferior' };
    return f;
  }

  function formatFormula(f) {
    function count(n, whorls) {
      var c = n === Infinity ? '∞' : String(n);
      if (whorls > 3) return '∞';
      if (whorls > 1) return Array(whorls + 1).join(c + '+').slice(0, -1);
      return c;
    }
    function part(letter, p) {
      if (!p) return '';
      var c = count(p.n, p.whorls || 1);
      return letter + (p.fused ? '(' + c + ')' : c);
    }
    // U+0332 combining low line marks a superior ovary, U+0305 combining overline an inferior one
    var gyn = 'G' + (f.G.position === 'superior' ? '̲' : '̅') + part('', f.G);
    var sym = f.symmetry === 'zygomorphic' ? '↑' : '⊕';
    var parts = [sym];
    if (f.P) parts.push(part('P', f.P));
    if (f.K) parts.push(part('K', f.K));
    if (f.C && f.A.epipetalous) parts.push('[' + part('C', f.C) + ' ' + part('A', f.A) + ']');
    else { if (f.C) parts.push(part('C', f.C)); parts.push(part('A', f.A)); }
    parts.push(gyn);
    return parts.join(' ');
  }

  // ------------------------------------------------------------------ genome: flower head

  var TIP_SHAPES = [['pointed', 30], ['rounded', 34], ['notched', 14], ['frilled', 14], ['toothed', 8]];

  function genPetalShape(r, o) {
    o = o || {};
    var tip = o.tip || r.weighted(o.tips || TIP_SHAPES);
    return {
      widthPos: o.widthPos != null ? o.widthPos : r.range(0.35, 0.75), // where the petal is widest, 0 base .. 1 tip
      belly: r.range(0.35, 1),        // how fast the width grows from the base
      claw: o.claw != null ? o.claw : r.range(0.08, 0.4), // base half-width / max half-width
      tip: tip,
      acumen: r.range(0, 1),          // pointed: 0 blunt .. 1 long drawn-out tip
      notch: r.range(0.06, 0.2),      // notched/toothed: depth as a fraction of length
      frill: tip !== 'frilled' ? null : r.chance(0.5)
        ? { style: 'fringed', amp: r.range(0.05, 0.1), wavelength: r.range(0.025, 0.05) }
        : { style: 'ruffled', amp: r.range(0.04, 0.08), wavelength: r.range(0.08, 0.14) },
      cupAcross: r.range(0, 0.35),    // transverse curvature (edges lift)
      width: 0,                       // full width / length, set from count and overlap below
    };
  }

  // Width is derived from how much neighbouring petals should overlap:
  // overlap < 1 leaves gaps (star-like), > 1 makes petals overlap.
  function fitWidth(shape, count, r0, L, cup, overlap) {
    var reach = r0 + shape.widthPos * L * Math.max(Math.cos(cup), 0.3);
    shape.width = clamp((2 * overlap * reach * Math.sin(Math.PI / count)) / L, 0.07, 1.15);
    shape.overlap = overlap;
    return shape;
  }

  function genHead(r, f) {
    var R = 170 * r.range(0.8, 1.1); // approximate radius of the open flower in drawing units
    var h = { type: f.capitulum ? 'radiate' : f.C && f.C.whorls > 1 ? 'double' : 'simple', radius: R, whorls: [] };
    h.aestivation = r.weighted([['imbricate', 60], ['contort', 25], ['valvate', 15]]);
    h.zygo = f.symmetry === 'zygomorphic'
      ? { mode: r.pick(['banner', 'lip']), strength: r.range(0.12, 0.35), gather: r.range(0, 0.25) }
      : null;

    var cup = r.weighted([[r.range(-0.1, 0.25), 35], [r.range(0.25, 0.6), 35], [r.range(0.6, 1.0), 20], [r.range(1.0, 1.3), 10]]);
    var curl = cup > 0.8 && r.chance(0.5) ? r.range(-1.6, -0.6) : r.range(-0.5, 0.4); // strong reflex for lily-like cups

    function petalLength(r0, c) { return (R - r0) / Math.max(0.55, Math.cos(c * 0.7)); }

    if (h.type === 'radiate') {
      var rays = r.weighted([[8, 15], [13, 35], [21, 35], [34, 15]]);
      h.centerRadius = R * r.range(0.2, 0.42);
      var rayCup = r.range(-0.35, 0.25), rayCurl = r.range(-0.45, 0.2);
      var Lr = petalLength(h.centerRadius, rayCup);
      var ray = genPetalShape(r, { tips: [['toothed', 45], ['notched', 20], ['pointed', 20], ['rounded', 15]], claw: r.range(0.3, 0.7), widthPos: r.range(0.4, 0.7) });
      fitWidth(ray, rays, h.centerRadius, Lr, rayCup, r.range(0.45, 1.05));
      var rows = rays >= 21 && r.chance(0.4) ? 2 : 1;
      // involucral bracts (phyllaries) behind the rays
      var bract = fitWidth(genPetalShape(r, { tip: 'pointed', claw: 0.6 }), rays, h.centerRadius * 0.9, Lr * 0.35, 0.2, 0.9);
      h.whorls.push({ organ: 'bract', layer: 0, count: rays, offset: Math.PI / rays, r0: h.centerRadius * 0.9, length: Lr * r.range(0.25, 0.45), cup: r.range(0, 0.4), curl: r.range(-0.3, 0.1), jitter: 0.06, zygo: false, shape: bract });
      for (var k = 0; k < rows; k++) {
        h.whorls.push({ organ: 'ray', layer: 1 + k, count: rays, offset: k * Math.PI / rays, r0: h.centerRadius, length: Lr * (1 - k * 0.08), cup: rayCup + k * 0.12, curl: rayCurl, jitter: 0.09, zygo: false, shape: ray });
      }
      return h;
    }

    h.centerRadius = R * r.range(0.07, 0.2);
    var n = f.C ? f.C.n : f.P.n;
    var L = petalLength(h.centerRadius, cup);
    var petal = genPetalShape(r, f.C && f.C.fused ? { claw: r.range(0.75, 1) } : {});
    var overlap = f.C && f.C.fused ? r.range(1.05, 1.4) : h.type === 'double' ? r.range(1.0, 1.6) : r.range(0.55, 1.5);
    if (h.aestivation === 'valvate') overlap = Math.min(overlap, 0.95);
    fitWidth(petal, n, h.centerRadius, L, cup, overlap);

    var pOffset = h.zygo ? (h.zygo.mode === 'banner' ? Math.PI / 2 : -Math.PI / 2) : r.range(0, TAU);

    if (f.P) {
      // two whorls of tepals; the outer whorl is a little narrower
      var outer = JSON.parse(JSON.stringify(petal));
      outer.width *= r.range(0.7, 0.95);
      h.whorls.push({ organ: 'tepal', layer: 0, count: n, offset: pOffset + Math.PI / n, r0: h.centerRadius, length: L * r.range(0.95, 1.05), cup: cup * r.range(0.85, 1), curl: curl, jitter: 0.05, zygo: false, shape: outer });
      h.whorls.push({ organ: 'tepal', layer: 1, count: n, offset: pOffset, r0: h.centerRadius, length: L, cup: cup, curl: curl, jitter: 0.05, zygo: false, shape: petal });
      return h;
    }

    // calyx
    var sepal = genPetalShape(r, { tips: [['pointed', 70], ['rounded', 30]], claw: f.K.fused ? r.range(0.8, 1) : r.range(0.2, 0.6) });
    var sepalLen = L * r.range(0.35, 0.85);
    var sepalCup = cup * r.range(0.3, 0.9) - r.range(0, 0.3);
    fitWidth(sepal, n, h.centerRadius, sepalLen, sepalCup, f.K.fused ? r.range(1.0, 1.2) : r.range(0.35, 0.85));
    h.whorls.push({ organ: 'sepal', layer: 0, count: n, offset: pOffset + Math.PI / n, r0: h.centerRadius, length: sepalLen, cup: sepalCup, curl: r.range(-0.4, 0.2), jitter: 0.06, zygo: false, shape: sepal });

    // corolla: one whorl, or several for a double flower (inner whorls shorter and more upright)
    var whorls = f.C.whorls;
    for (var w = 0; w < whorls; w++) {
      var t = whorls > 1 ? w / (whorls - 1) : 0;
      var wl = L * Math.pow(r.range(0.8, 0.9), w);
      var wc = lerp(cup, Math.max(cup, 1.25), t * 0.85);
      var wr0 = h.centerRadius * (1 - 0.45 * t);
      var ws = w === 0 ? petal : fitWidth(JSON.parse(JSON.stringify(petal)), n, wr0, wl, wc, overlap * r.range(0.95, 1.15));
      h.whorls.push({ organ: 'petal', layer: 1 + w, count: n, offset: pOffset + w * (Math.PI / n + r.range(-0.15, 0.15)), r0: wr0, length: wl, cup: wc, curl: curl * (1 - 0.6 * t), jitter: 0.05 + 0.03 * t, zygo: !!h.zygo, shape: ws });
    }
    return h;
  }

  // Orientation of the flower head. Rendering input, not anatomy; step 4 will set
  // one pose per flower of an inflorescence.
  function genPose(r, f) {
    return {
      tilt: r.chance(0.35) ? r.range(0, 0.15) : r.range(0.3, 1.0), // face turned up/away from the viewer
      spin: f.symmetry === 'zygomorphic' ? r.range(-0.08, 0.08) : r.range(0, TAU),
      roll: r.range(-0.3, 0.3),
    };
  }

  // ------------------------------------------------------------------ genome: Latin name

  var GENUS_ROOTS = ['Calli', 'Heli', 'Chrys', 'Rhod', 'Leuc', 'Xanth', 'Cyan', 'Melan', 'Aster', 'Stell', 'Anemon',
    'Myri', 'Calyc', 'Sten', 'Platy', 'Dasy', 'Lept', 'Pachy', 'Ore', 'Hyl', 'Campan', 'Galan', 'Coryd', 'Erythr',
    'Glauc', 'Lamp', 'Nemor', 'Phyll', 'Saxi', 'Thalict', 'Trich', 'Zephyr', 'Eri', 'Pter', 'Sphaer', 'Ornith',
    'Hesper', 'Selen', 'Argyr', 'Aur', 'Mel', 'Cal', 'Ixi', 'Ophi', 'Tetr', 'Hapl'];
  var GENUS_SUFFIXES = [['anthus', 'm'], ['anthe', 'f'], ['ella', 'f'], ['ia', 'f'], ['aria', 'f'], ['opsis', 'f'],
    ['ago', 'f'], ['ula', 'f'], ['ium', 'n'], ['anthemum', 'n'], ['ocallis', 'f'], ['ostemon', 'm'], ['ina', 'f']];
  var ENDINGS = { m: 'us', f: 'a', n: 'um' };

  // Epithet reflects the genome: a pointed-petalled flower may be "acuminata", a doubled one "plena".
  function genName(r, f, h) {
    var root = r.pick(GENUS_ROOTS), suf = r.pick(GENUS_SUFFIXES);
    if (/[aeiouy]$/.test(root)) root = root.slice(0, -1);
    var genus = root + suf[0];
    var gender = suf[1];

    var main = h.whorls[h.whorls.length - 1];
    var cands = [];
    var tipWord = { pointed: 'acuminat', rounded: 'obtus', notched: 'emarginat', frilled: 'fimbriat', toothed: 'tridentat' };
    cands.push([tipWord[main.shape.tip], 3]);
    if (h.type === 'double') cands.push(['plen', 6]);
    if (h.type === 'radiate') cands.push(['radiat', 4], [main.count >= 21 ? 'multiradiat' : 'pauciradiat', 3]);
    if (f.P) cands.push(['liliiflor', 3]);
    if (f.C && !f.capitulum) cands.push([{ 3: 'tripetal', 4: 'tetrapetal', 5: 'pentapetal', 6: 'hexapetal' }[f.C.n], 2]);
    if (main.cup > 0.9) cands.push(['campanulat', 4]);
    if (main.cup < 0.2) cands.push(['rotat', 2]);
    if (main.curl < -0.6) cands.push(['reflex', 5]);
    if (main.shape.overlap < 0.8) cands.push(['stellat', 4]);
    if (h.zygo) cands.push([h.zygo.mode === 'lip' ? 'labiat' : 'vexillat', 5]);
    if (f.A.n === Infinity) cands.push(['polyandr', 2]);
    if (h.radius > 175) cands.push(['grandiflor', 2]);
    if (h.radius < 145) cands.push(['parviflor', 2]);
    var epithet = r.weighted(cands) + ENDINGS[gender];
    return { genus: genus, epithet: epithet, full: genus + ' ' + epithet };
  }

  // ------------------------------------------------------------------ genome: color

  function hslToHex(h, sat, l) {
    h = ((h % 360) + 360) % 360; sat /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = sat * Math.min(l, 1 - l);
    var f = function (n) {
      var v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return ('0' + Math.round(v * 255).toString(16)).slice(-2);
    };
    return '#' + f(0) + f(8) + f(4);
  }

  // Pastel palette: high lightness, moderate saturation. Each role is a two-stop
  // gradient from the flower center (`inner`) to the petal tips (`outer`).
  var PETAL_FAMILIES = [
    // [name, hue range, saturation range, weight]
    ['pink', [325, 350], [55, 75], 24], ['lavender', [258, 285], [40, 60], 18], ['yellow', [44, 56], [70, 85], 15],
    ['peach', [18, 32], [65, 80], 13], ['cream', [40, 52], [35, 55], 10], ['blue', [200, 222], [45, 65], 9],
    ['coral', [4, 14], [60, 75], 7], ['mint', [145, 165], [30, 45], 4],
  ];

  function genColor(r, f, h) {
    var fam = r.weighted(PETAL_FAMILIES.map(function (x) { return [x, x[3]]; }));
    var hue = r.range(fam[1][0], fam[1][1]), sat = r.range(fam[2][0], fam[2][1]);
    var petal;
    if (r.chance(0.3)) {
      // contrasting "eye" at the petal base, e.g. a deeper or warmer ring around the center
      var eyeHue = hue + r.pick([-40, -25, 25, 40]);
      petal = { inner: hslToHex(eyeHue, sat * 0.9, r.range(68, 74)), outer: hslToHex(hue, sat, r.range(84, 90)), eye: true };
    } else {
      var light = r.range(80, 86);
      var tipLighter = r.chance(0.6);
      petal = { inner: hslToHex(hue, sat, tipLighter ? light - 6 : light + 4), outer: hslToHex(hue, sat * 0.9, tipLighter ? light + 5 : light - 4), eye: false };
    }
    var gh = r.range(85, 125), gs = r.range(22, 38);
    var green = { inner: hslToHex(gh, gs, r.range(66, 72)), outer: hslToHex(gh + 8, gs * 0.9, r.range(76, 82)) };
    var center = h.type === 'radiate'
      ? r.chance(0.5) ? { inner: hslToHex(r.range(38, 48), 65, 66), outer: hslToHex(r.range(38, 48), 60, 74) }  // golden disc
                      : { inner: hslToHex(r.range(20, 30), 30, 52), outer: hslToHex(r.range(25, 35), 35, 64) }   // brown disc
      : { inner: hslToHex(r.range(48, 56), 75, 72), outer: hslToHex(r.range(48, 56), 70, 80) };
    return { family: fam[0], petal: petal, green: green, center: center };
  }

  function makeGenome(seed) {
    seed = String(seed);
    var formula = genFormula(makeRng(seed, 'formula'));
    var head = genHead(makeRng(seed, 'head'), formula);
    var pose = genPose(makeRng(seed, 'pose'), formula);
    var name = genName(makeRng(seed, 'name'), formula, head);
    var color = genColor(makeRng(seed, 'color'), formula, head);
    return {
      version: 1,
      seed: seed,
      name: name,
      formula: formula,
      formulaText: formatFormula(formula),
      head: head,
      pose: pose,
      color: color,
      // reserved for later steps: center (2), stem/leaves (3), inflorescence (4), shading (5)
    };
  }

  // ------------------------------------------------------------------ geometry: petal outline (2D, petal-local)

  // Petal-local coordinates: s runs base (0) -> tip (L), t across the petal.
  // Builds the right half from cubic Beziers, mirrors it, then perturbs the edge.
  function petalOutline(shape, L, rng) {
    var W = (shape.width * L) / 2;
    var wp = shape.widthPos * L, tl = L - wp, b = shape.claw * W;
    var M = [wp, W];
    var right = cubicPts([0, b], [wp * 0.45, lerp(b, W, shape.belly)], [wp * 0.8, W], M, 20);

    switch (shape.tip) {
      case 'pointed': {
        var a = shape.acumen;
        append(right, cubicPts(M, [wp + tl * lerp(0.5, 0.2, a), W], [L - tl * lerp(0.25, 0.6, a), W * lerp(0.35, 0.04, a)], [L, 0], 30));
        break;
      }
      case 'notched': {
        var nd = Math.min(shape.notch * L, tl * 0.6), A = [L, W * 0.45];
        append(right, cubicPts(M, [wp + tl * 0.55, W], [L, lerp(A[1], W, 0.85)], A, 24));
        append(right, cubicPts(A, [L, A[1] * 0.35], [L - nd * 0.55, W * 0.08], [L - nd, 0], 14));
        break;
      }
      case 'toothed': {
        // three teeth: one on the axis, one either side; sinuses between them
        var d = Math.min(shape.notch * L, tl * 0.5), P = W * 0.6, tEnd = W * 0.9;
        var toothX = function (t) { return L - d * Math.pow(Math.abs(Math.sin((Math.PI * t) / P)), 0.8); };
        var E = [toothX(tEnd), tEnd];
        append(right, cubicPts(M, [wp + tl * 0.5, W], [E[0] - tl * 0.12, lerp(E[1], W, 0.7)], E, 20));
        var teeth = [];
        for (var i = 0; i <= 30; i++) { var tt = tEnd * (1 - i / 30); teeth.push([toothX(tt), tt]); }
        append(right, teeth);
        break;
      }
      default: // rounded, frilled
        append(right, cubicPts(M, [wp + tl * 0.55, W], [L, W * 0.55], [L, 0], 30));
    }

    var asym = 1 + rng.range(-0.06, 0.06);
    var pts = right.slice();
    for (var j = right.length - 2; j >= 0; j--) pts.push([right[j][0], -right[j][1] * asym]);
    pts = resample(pts, Math.max(0.6, L / 160));

    // every petal gets a slight low-frequency wobble; frilled petals also get a ruffle near the tip
    perturbEdge(pts, L, W, rng, W * 0.03, L * 0.35, 0.15);
    if (shape.frill) perturbEdge(pts, L, W, rng, W * shape.frill.amp, L * shape.frill.wavelength, 0.4);
    return pts;
  }

  // Displace an outline along its normal: sum of two sines in arc length,
  // fading in from `start` (fraction of length) toward the tip.
  function perturbEdge(pts, L, W, rng, amp, wavelength, start) {
    var k = TAU / wavelength, ph1 = rng.range(0, TAU), ph2 = rng.range(0, TAU);
    var arc = 0, disp = [];
    for (var i = 0; i < pts.length; i++) {
      if (i) arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      var p = pts[Math.min(i + 1, pts.length - 1)], q = pts[Math.max(i - 1, 0)];
      var tx = p[0] - q[0], ty = p[1] - q[1], tn = Math.hypot(tx, ty) || 1;
      var env = smoothstep(start, Math.min(start + 0.55, 0.98), pts[i][0] / L);
      var d = amp * env * (0.65 * Math.sin(k * arc + ph1) + 0.35 * Math.sin(2.3 * k * arc + ph2));
      disp.push([(-ty / tn) * d, (tx / tn) * d]);
    }
    for (var j = 0; j < pts.length; j++) { pts[j][0] += disp[j][0]; pts[j][1] += disp[j][1]; }
  }

  // ------------------------------------------------------------------ geometry: petal in 3D

  // The midrib rises from the flower plane at angle `cup` and bends further by
  // `curl` toward the tip (negative curl = reflexed, bending outward/down).
  function makeSpine(L, cup, curl) {
    var n = 48, ds = L / n, rho = [0], z = [0], phi = [cup], R = 0, Z = 0;
    for (var i = 0; i < n; i++) {
      var a = cup + curl * Math.pow((i + 0.5) / n, 1.6);
      R += Math.cos(a) * ds; Z += Math.sin(a) * ds;
      rho.push(R); z.push(Z); phi.push(cup + curl * Math.pow((i + 1) / n, 1.6));
    }
    return { L: L, n: n, rho: rho, z: z, phi: phi };
  }

  function spineAt(sp, s) {
    var x = clamp(s / sp.L, 0, 1) * sp.n, i = Math.min(Math.floor(x), sp.n - 1), f = x - i;
    var over = Math.max(0, s - sp.L); // frills can reach slightly past the tip
    var phi = lerp(sp.phi[i], sp.phi[i + 1], f);
    return { rho: lerp(sp.rho[i], sp.rho[i + 1], f) + over * Math.cos(phi), z: lerp(sp.z[i], sp.z[i + 1], f) + over * Math.sin(phi), phi: phi };
  }

  // petal-local (s, t) -> flower space (x, y, z); z points out of the flower face
  function bendPoint(p, sp, r0, theta, cupAcross, W) {
    var m = spineAt(sp, p[0]);
    var h = cupAcross * W * (p[1] / W) * (p[1] / W); // transverse cupping, along the spine normal
    var radial = r0 + m.rho - Math.sin(m.phi) * h;
    var z = m.z + Math.cos(m.phi) * h;
    var c = Math.cos(theta), s = Math.sin(theta);
    return [radial * c - p[1] * s, radial * s + p[1] * c, z];
  }

  // flower space -> screen. spin about the flower axis, tilt the face up/away, roll in the picture plane.
  function makeProjector(pose, cx, cy) {
    var cs = Math.cos(pose.spin), ss = Math.sin(pose.spin);
    var ct = Math.cos(pose.tilt), st = Math.sin(pose.tilt);
    var cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
    return function (p) {
      var x1 = p[0] * cs - p[1] * ss, y1 = p[0] * ss + p[1] * cs, z1 = p[2];
      var y2 = y1 * ct + z1 * st, z2 = -y1 * st + z1 * ct;
      var x3 = x1 * cr - y2 * sr, y3 = x1 * sr + y2 * cr;
      return [cx + x3, cy - y3, z2]; // [screen x, screen y, depth toward viewer]
    };
  }

  // ------------------------------------------------------------------ anatomical parts

  // Step 1: perianth whorls (bracts, sepals, petals, tepals, rays). One item per organ.
  function drawPerianth(g, rng, project) {
    var h = g.head, items = [];
    h.whorls.forEach(function (w) {
      for (var i = 0; i < w.count; i++) {
        var theta = w.offset + (i * TAU) / w.count + rng.gauss(0, w.jitter * 0.35 * (TAU / w.count));
        var scale = 1;
        if (w.zygo) {
          var axis = h.zygo.mode === 'banner' ? Math.PI / 2 : -Math.PI / 2;
          var d = theta - axis;
          scale = 1 + h.zygo.strength * Math.cos(d);
          theta += h.zygo.gather * Math.sin(d);
        }
        var L = w.length * scale * (1 + rng.gauss(0, w.jitter));
        var shape = Object.assign({}, w.shape, { width: w.shape.width * (1 + rng.gauss(0, w.jitter * 0.6)) });
        if (w.zygo) shape.width *= lerp(1, scale, 0.3);
        var W = (shape.width * L) / 2;
        var sp = makeSpine(L, w.cup + rng.gauss(0, 0.05), w.curl + rng.gauss(0, 0.08));
        var outline = petalOutline(shape, L, rng);
        var scr = outline.map(function (p) { return project(bendPoint(p, sp, w.r0, theta, shape.cupAcross, W)); });
        var mid = project(bendPoint([L * 0.5, 0], sp, w.r0, theta, shape.cupAcross, W));
        // Same-whorl organs at equal depth are ordered by aestivation:
        // imbricate/contort -> each organ slightly above the previous one.
        var bias = w.layer * 0.5 + (h.aestivation === 'valvate' ? 0 : (i / w.count) * 0.3);
        var poly = scr.map(function (p) { return [p[0], p[1]]; });
        items.push({ part: w.organ, role: w.organ === 'sepal' || w.organ === 'bract' ? 'green' : 'petal', depth: mid[2] + bias, outline: poly, strokes: [poly] });
      }
    });
    return items;
  }

  // Placeholder receptacle until step 2 (stamens, pistil, phyllotactic florets).
  function drawCenterPlaceholder(g, project) {
    var r = g.head.whorls.reduce(function (m, w) { return Math.min(m, w.r0); }, Infinity);
    var ring = function (rad, z) {
      var pts = [];
      for (var i = 0; i <= 72; i++) { var a = (i / 72) * TAU; pts.push(project([rad * Math.cos(a), rad * Math.sin(a), z])); }
      return pts;
    };
    var outer = ring(r, 0);
    // The receptacle carries the stamens and pistil, which stand above the petal bases:
    // place it one radius nearer than its nearest rim point so petal claws pass behind it.
    var depth = outer.reduce(function (m, p) { return Math.max(m, p[2]); }, -Infinity) + r;
    var flat = function (pts) { return pts.map(function (p) { return [p[0], p[1]]; }); };
    return [{ part: 'center', role: 'center', depth: depth, outline: flat(outer), strokes: [flat(outer), flat(ring(r * 0.45, 0))] }];
  }

  // ------------------------------------------------------------------ hidden-line removal

  function makeOccluder(poly) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return { poly: poly, x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function insidePoly(poly, x, y) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function hidden(occ, p) {
    for (var i = 0; i < occ.length; i++) {
      var o = occ[i];
      if (p[0] < o.x0 || p[0] > o.x1 || p[1] < o.y0 || p[1] > o.y1) continue;
      if (insidePoly(o.poly, p[0], p[1])) return true;
    }
    return false;
  }

  // Remove the parts of a polyline that fall inside any occluder.
  // Boundary crossings are located by bisection between neighbouring samples.
  function clipPolyline(line, occ) {
    if (!occ.length) return [line];
    var out = [], cur = null, prev = null, prevHidden = true;
    for (var i = 0; i < line.length; i++) {
      var p = line[i], hid = hidden(occ, p);
      if (prev && hid !== prevHidden) {
        var a = prev, b = p;
        for (var k = 0; k < 10; k++) {
          var m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (hidden(occ, m) === prevHidden) a = m; else b = m;
        }
        var edge = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (hid) { cur.push(edge); if (cur.length > 1) out.push(cur); cur = null; }
        else cur = [edge];
      }
      if (!hid) { if (!cur) cur = []; cur.push(p); }
      prev = p; prevHidden = hid;
    }
    if (cur && cur.length > 1) out.push(cur);
    return out;
  }

  function resolveOcclusion(items) {
    items.sort(function (a, b) { return b.depth - a.depth; }); // nearest first
    var occ = [], lines = [];
    items.forEach(function (it) {
      it.strokes.forEach(function (s) { lines.push.apply(lines, clipPolyline(s, occ)); });
      occ.push(makeOccluder(it.outline));
    });
    // Color washes are painted farthest first, so nearer organs cover farther ones.
    var fills = items.slice().reverse().map(function (it) { return { role: it.role, poly: it.outline }; });
    return { lines: lines, fills: fills };
  }

  // ------------------------------------------------------------------ assembly & SVG

  // color: false gives lines only (pen-plotter output)
  var DEFAULTS = { width: 600, height: 720, stroke: 0.9, labels: true, color: true };

  function draw(g, opts) {
    opts = Object.assign({}, DEFAULTS, opts);
    var rng = makeRng(g.seed, 'draw.head');
    var project = makeProjector(g.pose, opts.width / 2, opts.height * 0.43);
    var items = [].concat(drawPerianth(g, rng, project), drawCenterPlaceholder(g, project));
    var res = resolveOcclusion(items);
    var c = project([0, 0, 0]);
    res.center = [c[0], c[1]];
    return res;
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function pointList(pts) {
    return pts.map(function (p) { return round2(p[0]) + ' ' + round2(p[1]); }).join(' L');
  }

  // Pastel wash under the linework, one gradient per color role.
  function colorLayer(g, d) {
    // gradient ids carry a seed hash so several flowers can share one SVG document
    var id = 'fd' + hash128(g.seed)[0].toString(36);
    var cx = round2(d.center[0]), cy = round2(d.center[1]);
    var roles = { petal: g.head.radius, green: g.head.radius * 0.8, center: g.head.centerRadius * 1.2 };
    var defs = Object.keys(roles).map(function (role) {
      var c = g.color[role];
      return '<radialGradient id="' + id + '-' + role + '" gradientUnits="userSpaceOnUse" cx="' + cx + '" cy="' + cy + '" r="' + round2(roles[role]) + '">' +
        '<stop offset="0" stop-color="' + c.inner + '"/><stop offset="1" stop-color="' + c.outer + '"/></radialGradient>';
    });
    var shapes = d.fills.map(function (f) { return '<path fill="url(#' + id + '-' + f.role + ')" d="M' + pointList(f.poly) + 'Z"/>'; });
    return ['<defs>' + defs.join('') + '</defs>', '<g id="color" stroke="none">', shapes.join('\n'), '</g>'];
  }

  function toSVG(g, d, opts) {
    opts = Object.assign({}, DEFAULTS, opts);
    var W = opts.width, H = opts.height;
    var paths = d.lines.map(function (l) { return '<path d="M' + pointList(l) + '"/>'; });
    var out = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
      '<rect width="' + W + '" height="' + H + '" fill="' + (opts.color ? '#fbf8f1' : 'white') + '"/>',
    ];
    if (opts.color) out.push.apply(out, colorLayer(g, d));
    out.push(
      '<g id="drawing" fill="none" stroke="' + (opts.color ? '#2b2522' : 'black') + '" stroke-width="' + opts.stroke + '" stroke-linecap="round" stroke-linejoin="round">',
      paths.join('\n'),
      '</g>'
    );
    if (opts.labels) {
      var caption = g.formula.capitulum
        ? 'capitulum of ' + g.head.whorls[g.head.whorls.length - 1].count + ' ray florets; disc floret ' + g.formulaText
        : g.formulaText;
      out.push(
        '<g id="labels" font-family="Georgia, \'Times New Roman\', serif" text-anchor="middle" fill="black">',
        '<text x="' + W / 2 + '" y="' + (H - 70) + '" font-size="22" font-style="italic">' + escapeXml(g.name.full) + '</text>',
        '<text x="' + W / 2 + '" y="' + (H - 42) + '" font-size="15">' + escapeXml(caption) + '</text>',
        '</g>'
      );
    }
    out.push('</svg>');
    return out.join('\n');
  }

  function generate(seed, opts) {
    var g = makeGenome(seed);
    var d = draw(g, opts);
    return { genome: g, lines: d.lines, fills: d.fills, svg: toSVG(g, d, opts) };
  }

  var api = {
    generate: generate, makeGenome: makeGenome, draw: draw, toSVG: toSVG,
    formatFormula: formatFormula, makeRng: makeRng, GOLDEN_ANGLE: GOLDEN_ANGLE,
    _internal: { drawPerianth: drawPerianth, drawCenterPlaceholder: drawCenterPlaceholder, makeProjector: makeProjector, insidePoly: insidePoly, petalOutline: petalOutline },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.petaldraw = api;

  // ------------------------------------------------------------------ CLI

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    var argv = process.argv.slice(2), args = {};
    for (var i = 0; i < argv.length; i++) {
      if (argv[i].indexOf('--') === 0) {
        var key = argv[i].slice(2);
        args[key] = argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : true;
      }
    }
    var seed = args.seed != null ? String(args.seed) : String(Math.floor(Math.random() * 1e9));
    var res = generate(seed, { color: !args.mono });
    process.stderr.write('seed: ' + seed + '  ' + res.genome.name.full + '  ' + res.genome.formulaText + '\n');
    var text = args.genome ? JSON.stringify(res.genome, (k, v) => (v === Infinity ? 'Infinity' : v), 2) : res.svg;
    if (args.out) require('fs').writeFileSync(args.out, text);
    else process.stdout.write(text + '\n');
  }
})(typeof self !== 'undefined' ? self : this);
