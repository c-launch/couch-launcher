'use strict';
// A small QR code maker (byte mode, error correction M, versions 1-10), for the phone remote's
// link. qrSVG(text) returns an <svg> string. Follows the QR standard (ISO/IEC 18004).
(function () {
  // Per version (1-10), level M: [data codewords per block group..., ec codewords per block]
  // as { ec, blocks: [[count, dataCodewords], ...] }.
  const M = [null,
    { ec: 10, blocks: [[1, 16]] }, { ec: 16, blocks: [[1, 28]] }, { ec: 26, blocks: [[1, 44]] },
    { ec: 18, blocks: [[2, 32]] }, { ec: 24, blocks: [[2, 43]] }, { ec: 16, blocks: [[4, 27]] },
    { ec: 18, blocks: [[4, 31]] }, { ec: 22, blocks: [[2, 38], [2, 39]] }, { ec: 22, blocks: [[3, 36], [2, 37]] },
    { ec: 26, blocks: [[4, 43], [1, 44]] }];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) for Reed-Solomon.
  const EXP = new Array(512), LOG = new Array(256);
  (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g; // g[0] = 1
  }
  function rsRem(data, n) {
    const g = rsGen(n), r = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ r[0];
      r.shift(); r.push(0);
      for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f);
    }
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const cap = M[v].blocks.reduce((s, [c, d]) => s + c * d, 0);
      const bits = 4 + (v < 10 ? 8 : 16) + 8 * bytes.length;
      if (bits <= cap * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('Too long for a QR code');
    const info = M[ver];
    const cap = info.blocks.reduce((s, [c, d]) => s + c * d, 0);
    // Bit stream.
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xEC);
    // Blocks, error correction, interleaving.
    const blocks = [];
    let k = 0;
    for (const [count, dc] of info.blocks) for (let i = 0; i < count; i++) { const d = data.slice(k, k + dc); k += dc; blocks.push({ d, e: rsRem(d, info.ec) }); }
    const out = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < info.ec; i++) for (const b of blocks) out.push(b.e[i]);

    const size = 17 + 4 * ver;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, on) => { mods[y][x] = !!on; fixed[y][x] = true; };
    // Finder patterns + separators.
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
    // Timing.
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // Alignment.
    const al = ALIGN[ver];
    for (const ay of al) for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Dark module and reserved format / version areas.
    set(8, size - 8, true);
    for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(i, 8, false); if (!fixed[i][8]) set(8, i, false); }
    for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); if (!fixed[size - 1 - i][8]) set(8, size - 1 - i, false); }
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const vb = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }
    // Data in the zigzag.
    const stream = [];
    for (const b of out) for (let i = 7; i >= 0; i--) stream.push((b >>> i) & 1);
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (fixed[y][x]) continue;
          mods[y][x] = bi < stream.length ? !!stream[bi] : false;
          bi++;
        }
      }
    }
    // Try the 8 masks, keep the best.
    const maskFn = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    ];
    function withMask(m) {
      const g = mods.map((row) => row.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && maskFn[m](x, y)) g[y][x] = !g[y][x];
      // Format bits: level M (00) + mask.
      const fdata = (0 << 3) | m;
      let rem = fdata;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const fb = ((fdata << 10) | rem) ^ 0x5412;
      const bit = (i) => ((fb >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
      g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
      for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
      for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
      for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
      g[size - 8][8] = true;
      return g;
    }
    function penalty(g) {
      let p = 0;
      const lines = [];
      for (let y = 0; y < size; y++) { lines.push(g[y]); lines.push(g.map((r) => r[y])); }
      for (const l of lines) {
        let run = 1;
        for (let i = 1; i <= l.length; i++) {
          if (i < l.length && l[i] === l[i - 1]) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        const s = l.map((v) => (v ? 1 : 0)).join('');
        for (const pat of ['10111010000', '00001011101']) { let at = s.indexOf(pat); while (at >= 0) { p += 40; at = s.indexOf(pat, at + 1); } }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = g[y][x]; if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3; }
      const dark = g.reduce((s, r) => s + r.filter(Boolean).length, 0);
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    }
    let best = null, bestP = Infinity;
    for (let m = 0; m < 8; m++) { const g = withMask(m); const p = penalty(g); if (p < bestP) { bestP = p; best = g; } }
    return best;
  }

  function qrSVG(text, opts) {
    const g = encode(text);
    const n = g.length, q = 4;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    const fg = (opts && opts.fg) || '#000', bg = (opts && opts.bg) || '#fff';
    return '<svg class="qr" viewBox="0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q) + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="' + bg + '"/><path d="' + d + '" fill="' + fg + '"/></svg>';
  }
  const api = { qrSVG, qrMatrix: encode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CouchQR = api;
})();
