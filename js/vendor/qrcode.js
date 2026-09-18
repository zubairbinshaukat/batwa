/*!
 * Minimal QR Code generator — byte mode, error-correction level L, versions 1-14.
 *
 * MIT License. Written for Batwa from the ISO/IEC 18004 specification; the
 * structure follows the classic `qrcode-generator` approach (Kazuhiko Arase,
 * MIT) without copying its code. No dependencies, no DOM, no canvas: it hands
 * back a bit matrix and an SVG string, which is all the invite sheet needs.
 *
 * Scope, deliberately small: byte mode only (our invite code is ASCII
 * base64url), level L only (an invite is shown on a phone screen, in person,
 * at a comfortable size — L keeps the module count low and the squares big),
 * versions 1-14 (up to 581 codewords, far more than a ~240-char invite).
 */

/* ============================================================
   GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
   ============================================================ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

/** Multiply in GF(256). Exported for the fixture's syndrome check. */
export function gmul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** α^k, for callers that want to evaluate a codeword polynomial. */
export const gexp = (k) => EXP[((k % 255) + 255) % 255];

function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], 1);
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon parity for one block. */
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j <= ecLen; j++) buf[i + j] ^= gmul(gen[j], factor);
  }
  return buf.slice(data.length);
}

/* ============================================================
   Version tables (level L only)
   ============================================================ */

/** Total codewords per version — the fixture cross-checks RS_L against this. */
export const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581,
];

/** version -> [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]] */
export const RS_L = {
  1:  [7,  [[1, 19]]],
  2:  [10, [[1, 34]]],
  3:  [15, [[1, 55]]],
  4:  [20, [[1, 80]]],
  5:  [26, [[1, 108]]],
  6:  [18, [[2, 68]]],
  7:  [20, [[2, 78]]],
  8:  [24, [[2, 97]]],
  9:  [30, [[2, 116]]],
  10: [18, [[2, 68], [2, 69]]],
  11: [20, [[4, 81]]],
  12: [24, [[2, 92], [2, 93]]],
  13: [26, [[4, 107]]],
  14: [30, [[3, 115], [1, 116]]],
};

/** Alignment-pattern centre coordinates per version. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
};

/** Remainder bits appended after the interleaved codeword stream. */
function remainderBits(version) {
  if (version === 1) return 0;
  if (version <= 6) return 7;
  if (version <= 13) return 0;
  return 3;
}

/** Usable data codewords for a version at level L. */
function dataCapacity(version) {
  const [, groups] = RS_L[version];
  return groups.reduce((n, [count, len]) => n + count * len, 0);
}

/* ============================================================
   Bit buffer
   ============================================================ */

function bitBuffer() {
  const bytes = [];
  let length = 0;
  return {
    get length() { return length; },
    put(value, bits) {
      for (let i = bits - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
    },
    putBit(on) {
      const i = length >>> 3;
      if (bytes.length <= i) bytes.push(0);
      if (on) bytes[i] |= 0x80 >>> (length & 7);
      length++;
    },
    bytes: () => Uint8Array.from(bytes),
  };
}

/* ============================================================
   BCH codes for the format and version information
   ============================================================ */

function bchDigit(v) {
  let n = 0;
  while (v !== 0) { n++; v >>>= 1; }
  return n;
}

const G15 = 0b101_0011_0111;           // x^10+x^8+x^5+x^4+x^2+x+1
const G18 = 0b1_1111_0010_0101;        // x^12+x^11+x^10+x^9+x^8+x^5+x^2+1
const G15_MASK = 0b101_0100_0001_0010;

function formatInfo(maskId) {
  // level L = 0b01
  const data = (0b01 << 3) | maskId;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function versionInfo(version) {
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (version << 12) | d;
}

/* ============================================================
   Masks and penalty scoring
   ============================================================ */

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

const FINDER_RUN = [1, 0, 1, 1, 1, 0, 1];

function penalty(m, size) {
  const at = (r, c) => m[r * size + c];
  let score = 0;

  // Rule 1 — runs of five or more
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = pass === 0 ? at(a, 0) : at(0, a);
      for (let b = 1; b < size; b++) {
        const v = pass === 0 ? at(a, b) : at(b, a);
        if (v === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          prev = v;
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — 2x2 blocks of one colour
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3 — finder-like 1:1:3:1:1 runs with four light modules on one side
  const matches = (get, a, start) => {
    for (let k = 0; k < 7; k++) if (get(a, start + k) !== FINDER_RUN[k]) return false;
    let before = true, after = true;
    for (let k = 1; k <= 4; k++) {
      if (start - k < 0 || get(a, start - k) !== 0) { before = false; break; }
    }
    for (let k = 7; k < 11; k++) {
      if (start + k >= size || get(a, start + k) !== 0) { after = false; break; }
    }
    return before || after;
  };
  const row = (a, b) => at(a, b);
  const col = (a, b) => at(b, a);
  for (let a = 0; a < size; a++) {
    for (let b = 0; b <= size - 7; b++) {
      if (matches(row, a, b)) score += 40;
      if (matches(col, a, b)) score += 40;
    }
  }

  // Rule 4 — deviation from a 50/50 balance
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* ============================================================
   Matrix construction
   ============================================================ */

function blankMatrix(size) {
  return { m: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function placeFunctionPatterns(grid, size, version) {
  const { m, reserved } = grid;
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r * size + c] = v;
    reserved[r * size + c] = 1;
  };

  // Finders + separators
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const on = inner && (r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(br + r, bc + c, on ? 1 : 0);
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns (skipping the three that would sit on a finder)
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }

  // Dark module
  set(size - 8, 8, 1);

  // Reserve the format-information areas
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { set(8, i, 0); set(i, 8, 0); }
  }
  set(8, 8, 0);
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    set(size - 1 - i, 8, 0);
  }

  // Reserve the version-information areas
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      set(size - 11 + c, r, 0);
      set(r, size - 11 + c, 0);
    }
  }
}

function placeData(grid, size, bits) {
  const { m, reserved } = grid;
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is never a data column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = right - k;
        const idx = r * size + c;
        if (reserved[idx]) continue;
        m[idx] = bit < bits.length ? bits[bit] : 0;
        bit++;
      }
    }
    upward = !upward;
  }
}

function writeFormat(m, size, maskId) {
  const bits = formatInfo(maskId);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1 ? 1 : 0;
    // vertical strip, top-left
    if (i < 6) m[i * size + 8] = on;
    else if (i < 8) m[(i + 1) * size + 8] = on;
    else m[(size - 15 + i) * size + 8] = on;
    // horizontal strip, top-left + top-right
    if (i < 8) m[8 * size + (size - 1 - i)] = on;
    else if (i < 9) m[8 * size + (15 - i - 1 + 1)] = on;
    else m[8 * size + (15 - i - 1)] = on;
  }
  m[(size - 8) * size + 8] = 1; // dark module, always
}

function writeVersion(m, size, version) {
  if (version < 7) return;
  const bits = versionInfo(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1 ? 1 : 0;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[(size - 11 + c) * size + r] = on;
    m[r * size + (size - 11 + c)] = on;
  }
}

/* ============================================================
   Public API
   ============================================================ */

/**
 * The function-pattern map for a version: `reserved[r * size + c]` is 1 where
 * a module belongs to a finder, timing, alignment, format or version pattern.
 * Exported so the fixture can read a finished matrix back.
 */
export function functionMap(version) {
  const size = version * 4 + 17;
  const grid = blankMatrix(size);
  placeFunctionPatterns(grid, size, version);
  return { size, reserved: grid.reserved };
}

/**
 * Build the codeword stream (data + interleaved EC) for `bytes` at `version`.
 * Exported so the fixture can re-derive and check it.
 */
export function codewords(bytes, version) {
  const buf = bitBuffer();
  buf.put(0b0100, 4);                              // byte mode
  buf.put(bytes.length, version < 10 ? 8 : 16);    // character count
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  if (buf.length > capacityBits) throw new Error("qr-overflow");
  const terminator = Math.min(4, capacityBits - buf.length);
  buf.put(0, terminator);
  while (buf.length % 8 !== 0) buf.putBit(false);

  const data = Array.from(buf.bytes());
  const pads = [0xec, 0x11];
  let p = 0;
  while (data.length < dataCapacity(version)) data.push(pads[p++ % 2]);

  const [ecLen, groups] = RS_L[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const block = Uint8Array.from(data.slice(at, at + len));
      at += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return { stream: Uint8Array.from(out), dataBlocks, ecBlocks, ecLen };
}

/** The smallest level-L version that holds `byteLength` bytes. */
export function pickVersion(byteLength) {
  for (let v = 1; v <= 14; v++) {
    const headerBytes = v < 10 ? 2 : 3; // 4 mode bits + 8/16 count bits, rounded up
    if (byteLength + headerBytes <= dataCapacity(v)) return v;
  }
  throw new Error("qr-too-long");
}

/**
 * Encode `text` and return `{ size, version, mask, modules }`, where `modules`
 * is a Uint8Array of `size * size` zeros and ones, row-major.
 */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const { stream } = codewords(bytes, version);

  // Codewords -> bit array, plus the version's remainder bits.
  const bits = new Uint8Array(stream.length * 8 + remainderBits(version));
  for (let i = 0; i < stream.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (stream[i] >> (7 - b)) & 1;
  }

  const base = blankMatrix(size);
  placeFunctionPatterns(base, size, version);
  placeData(base, size, bits);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = Uint8Array.from(base.m);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const idx = r * size + c;
        if (base.reserved[idx]) continue;
        if (MASKS[mask](r, c)) m[idx] ^= 1;
      }
    }
    writeFormat(m, size, mask);
    writeVersion(m, size, version);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { score, mask, m };
  }

  return { size, version, mask: best.mask, modules: best.m };
}

/**
 * An SVG string for `text`. One `<path>` of module rectangles — no per-module
 * elements, so a 57x57 code is still a small DOM node.
 */
export function qrSvg(text, { margin = 2, dark = "currentColor", light = "none", label = "QR code" } = {}) {
  const { size, modules } = qrMatrix(text);
  const dim = size + margin * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    (light === "none" ? "" : `<rect width="${dim}" height="${dim}" fill="${light}"/>`) +
    `<path fill="${dark}" d="${d}"/></svg>`;
}
