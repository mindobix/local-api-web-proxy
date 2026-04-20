'use strict';

// Generates resources/icon.png (1024×1024) and resources/icon.ico (multi-size
// Windows icon) from scratch using only Node stdlib.
//
// Run with:   node scripts/generate-icon.js
//
//  icon.png  —  Linux AppImage uses this directly; electron-builder converts it
//               to .icns for the macOS dmg at build time.
//  icon.ico  —  Windows installer (NSIS MUI_ICON/MUI_UNICON) requires a real
//               .ico file; electron-builder also embeds this into the packaged
//               .exe for the app's taskbar + file-explorer icon.
//
// Design: indigo rounded-square with a soft vertical gradient, and a white
// line-art globe centered inside (outer ring + equator + central meridian +
// two side-meridian arcs). Globe = "web" — instantly readable for a web-proxy
// app, and visually distinct from file-sync / folder-style icons.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Config ────────────────────────────────────────────────────────────────
const W  = 1024;
const H  = 1024;
const OUT = path.join(__dirname, '..', 'resources', 'icon.png');

// Background: indigo gradient (top lighter, bottom darker) — feels like the
// attached reference icon.
const BG_TOP = [0x70, 0x72, 0xf4, 0xff]; // slightly lighter than indigo-500
const BG_BOT = [0x4f, 0x46, 0xe5, 0xff]; // indigo-600
const WHITE  = [0xff, 0xff, 0xff, 0xff];

// Rounded-square background
const CORNER_R = 210; // rounded-corner radius

// Globe
const CX = 512;
const CY = 512;
const GLOBE_R  = 340;  // outer radius of the globe outline
const STROKE   = 38;   // globe line thickness — survives downsampling to 16px
const MERIDIAN_RX = 176; // horizontal semi-axis of side meridian ellipse

// ─── Canvas ────────────────────────────────────────────────────────────────
const raw = Buffer.alloc(W * H * 4); // zero-filled = transparent

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  raw[i]     = color[0];
  raw[i + 1] = color[1];
  raw[i + 2] = color[2];
  raw[i + 3] = color[3];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
    255,
  ];
}

// ─── 1. Rounded-square background with a subtle vertical gradient ─────────
function insideRoundRect(x, y) {
  if (x >= CORNER_R && x < W - CORNER_R) return true;
  if (y >= CORNER_R && y < H - CORNER_R) return true;
  const cx = x < CORNER_R ? CORNER_R : W - 1 - CORNER_R;
  const cy = y < CORNER_R ? CORNER_R : H - 1 - CORNER_R;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= CORNER_R * CORNER_R;
}

for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const color = mix(BG_TOP, BG_BOT, t);
  for (let x = 0; x < W; x++) {
    if (insideRoundRect(x, y)) setPixel(x, y, color);
  }
}

// ─── 2. Drawing primitives ────────────────────────────────────────────────
function fillCircle(cx, cy, r, color) {
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(W, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(H, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, color);
    }
  }
}

// Circle stroke — uniform thickness (inside-outer AND outside-inner test).
function strokeCircle(cx, cy, r, thickness, color) {
  const rOut = r + thickness / 2;
  const rIn  = r - thickness / 2;
  const rOut2 = rOut * rOut;
  const rIn2  = rIn  * rIn;
  const minX = Math.max(0, Math.floor(cx - rOut));
  const maxX = Math.min(W, Math.ceil(cx + rOut));
  const minY = Math.max(0, Math.floor(cy - rOut));
  const maxY = Math.min(H, Math.ceil(cy + rOut));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= rOut2 && d2 >= rIn2) setPixel(x, y, color);
    }
  }
}

// Ellipse stroke — uniform perceived thickness via dense filled discs walked
// around the ellipse perimeter. Simpler and visually better than the
// inside-outer / outside-inner test, which gives non-uniform thickness on
// elongated ellipses.
function strokeEllipse(cx, cy, rx, ry, thickness, color) {
  const steps = Math.ceil(Math.PI * 2 * Math.max(rx, ry));
  const r = thickness / 2;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    fillCircle(cx + rx * Math.cos(a), cy + ry * Math.sin(a), r, color);
  }
}

function drawThickLine(x1, y1, x2, y2, thickness, color) {
  const r = thickness / 2;
  const dxL = x2 - x1, dyL = y2 - y1;
  const l2 = dxL * dxL + dyL * dyL;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r));
  const maxX = Math.min(W, Math.ceil(Math.max(x1, x2) + r));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r));
  const maxY = Math.min(H, Math.ceil(Math.max(y1, y2) + r));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = l2 === 0 ? 0 : ((px - x1) * dxL + (py - y1) * dyL) / l2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cxp = x1 + t * dxL;
      const cyp = y1 + t * dyL;
      const ddx = px - cxp, ddy = py - cyp;
      if (ddx * ddx + ddy * ddy <= r * r) setPixel(x, y, color);
    }
  }
}

// ─── 3. Globe — outer ring + equator + central meridian + side meridians ──
// Outer silhouette
strokeCircle(CX, CY, GLOBE_R, STROKE, WHITE);

// Equator (horizontal) — stops at the globe edge so it doesn't spill past.
drawThickLine(CX - GLOBE_R, CY, CX + GLOBE_R, CY, STROKE, WHITE);

// Central meridian (vertical)
drawThickLine(CX, CY - GLOBE_R, CX, CY + GLOBE_R, STROKE, WHITE);

// Side meridians — a single narrow ellipse whose left & right halves are the
// two side longitudes. Vertical radius = GLOBE_R so the meridian touches the
// poles cleanly; horizontal radius gives it its "half-a-globe" look.
strokeEllipse(CX, CY, MERIDIAN_RX, GLOBE_R, STROKE, WHITE);

// ─── 3. Encode as PNG ──────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr.writeUInt8(8, 8);  // bit depth
ihdr.writeUInt8(6, 9);  // color type 6 = RGBA
ihdr.writeUInt8(0, 10); // compression: deflate
ihdr.writeUInt8(0, 11); // filter method
ihdr.writeUInt8(0, 12); // interlace: none

// IDAT — prepend filter byte (0 = None) to each scanline, then deflate
const scanlineBytes = 1 + W * 4;
const scanlines = Buffer.alloc(H * scanlineBytes);
for (let y = 0; y < H; y++) {
  scanlines[y * scanlineBytes] = 0;
  raw.copy(scanlines, y * scanlineBytes + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(scanlines, { level: 9 });

const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const png = Buffer.concat([
  SIG,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);

console.log(`Wrote ${OUT}  (${(png.length / 1024).toFixed(1)} KB, ${W}×${H})`);

// ─── 4. Windows .ico — multi-size (16, 24, 32, 48, 64, 128, 256) ──────────
// NSIS MUI_ICON accepts only real .ico files. electron-builder also prefers
// .ico for win.icon (skips its internal PNG→ICO conversion, so colors stay
// exactly what we designed).

// Alpha-premultiplied box-filter downsample from the 1024² canvas.
function downsampleRgba(srcRgba, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const sxF = srcW / dstW;
  const syF = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * syF);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * syF));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * sxF);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sxF));
      let rA = 0, gA = 0, bA = 0, aSum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * srcW + xx) * 4;
          const a = srcRgba[i + 3];
          // Weight RGB by alpha for correct compositing over transparency
          rA += srcRgba[i]     * a;
          gA += srcRgba[i + 1] * a;
          bA += srcRgba[i + 2] * a;
          aSum += a;
          n += 1;
        }
      }
      const oi = (y * dstW + x) * 4;
      if (aSum > 0) {
        out[oi]     = Math.round(rA / aSum);
        out[oi + 1] = Math.round(gA / aSum);
        out[oi + 2] = Math.round(bA / aSum);
      }
      out[oi + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

// Encode a single ICO image as a BITMAPINFOHEADER DIB: header + BGRA
// pixel data (bottom-up) + AND mask. For 32-bpp alpha icons the AND mask
// is all zeros (alpha channel carries transparency); Buffer.alloc already
// zero-fills so we just leave that region untouched.
function encodeIcoDib(rgba, w, h) {
  const HEADER   = 40;
  const pxBytes  = w * h * 4;
  const maskStride = Math.ceil(w / 32) * 4; // 1 bit/px, row-padded to 4 bytes
  const maskBytes  = maskStride * h;
  const buf = Buffer.alloc(HEADER + pxBytes + maskBytes);

  buf.writeUInt32LE(HEADER, 0);
  buf.writeInt32LE(w, 4);
  buf.writeInt32LE(h * 2, 8);       // height includes AND mask plane
  buf.writeUInt16LE(1, 12);          // planes
  buf.writeUInt16LE(32, 14);         // bpp
  buf.writeUInt32LE(0, 16);          // BI_RGB
  buf.writeUInt32LE(pxBytes, 20);    // biSizeImage
  // XPelsPerMeter/YPelsPerMeter/ClrUsed/ClrImportant all zero (OK for icons)

  // BGRA, bottom-up
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = HEADER + y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      buf[d]     = rgba[s + 2]; // B
      buf[d + 1] = rgba[s + 1]; // G
      buf[d + 2] = rgba[s];     // R
      buf[d + 3] = rgba[s + 3]; // A
    }
  }
  return buf;
}

function encodeIco(images) {
  const DIR_ENTRY = 16;
  const headerSize = 6 + images.length * DIR_ENTRY;
  const blobs = images.map(({ rgba, w, h }) => encodeIcoDib(rgba, w, h));
  const total = headerSize + blobs.reduce((s, b) => s + b.length, 0);
  const out = Buffer.alloc(total);

  out.writeUInt16LE(0, 0);              // reserved
  out.writeUInt16LE(1, 2);              // type = icon
  out.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  for (let i = 0; i < images.length; i++) {
    const { w, h } = images[i];
    const blob = blobs[i];
    const e = 6 + i * DIR_ENTRY;
    out.writeUInt8(w === 256 ? 0 : w, e);       // width (0 means 256)
    out.writeUInt8(h === 256 ? 0 : h, e + 1);   // height
    out.writeUInt8(0, e + 2);                    // color palette
    out.writeUInt8(0, e + 3);                    // reserved
    out.writeUInt16LE(1, e + 4);                 // planes
    out.writeUInt16LE(32, e + 6);                // bpp
    out.writeUInt32LE(blob.length, e + 8);       // size
    out.writeUInt32LE(offset, e + 12);           // offset
    blob.copy(out, offset);
    offset += blob.length;
  }
  return out;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoImages = ICO_SIZES.map(s => ({
  w: s,
  h: s,
  rgba: downsampleRgba(raw, W, H, s, s),
}));

const ICO_OUT = path.join(__dirname, '..', 'resources', 'icon.ico');
const icoBuf = encodeIco(icoImages);
fs.writeFileSync(ICO_OUT, icoBuf);
console.log(`Wrote ${ICO_OUT}  (${(icoBuf.length / 1024).toFixed(1)} KB, sizes: ${ICO_SIZES.join(', ')})`);
