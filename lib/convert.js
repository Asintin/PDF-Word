'use strict';

const zlib = require('zlib');
const path = require('path');
const { pathToFileURL } = require('url');
const { Document, Packer, Paragraph, TextRun } = require('docx');

// ---------------------------------------------------------------
// DOMMatrix polyfill (pdfjs-dist requires it in Node.js)
// ---------------------------------------------------------------
class Matrix {
  constructor(init) {
    if (typeof init === 'string') {
      const m = init.match(/matrix\(([^)]+)\)/);
      if (m) { const v = m[1].split(/[\s,]+/).map(Number); this._set(v[0], v[1], v[2], v[3], v[4], v[5]); return; }
      this._set(1, 0, 0, 1, 0, 0); return;
    }
    if (Array.isArray(init)) {
      if (init.length === 6) this._set(init[0], init[1], init[2], init[3], init[4], init[5]);
      else if (init.length === 16) this._set(init[0], init[1], init[4], init[5], init[12], init[13]);
      else this._set(1, 0, 0, 1, 0, 0);
      return;
    }
    this._set(1, 0, 0, 1, 0, 0);
  }
  _set(a, b, c, d, e, f) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    this.m11 = a; this.m12 = b; this.m21 = c; this.m22 = d; this.m41 = e; this.m42 = f;
    this.m13 = 0; this.m14 = 0; this.m23 = 0; this.m24 = 0;
    this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0; this.m43 = 0; this.m44 = 1;
  }
  multiply(o) {
    const a = this.a * o.a + this.c * o.b, b = this.b * o.a + this.d * o.b;
    const c = this.a * o.c + this.c * o.d, d = this.b * o.c + this.d * o.d;
    const e = this.a * o.e + this.c * o.f + this.e, f = this.b * o.e + this.d * o.f + this.f;
    const r = new Matrix(); r._set(a, b, c, d, e, f); return r;
  }
  translate(x, y = 0) { return this.multiply(new Matrix([1, 0, 0, 1, x, y])); }
  scale(sx, sy = sx) { return this.multiply(new Matrix([sx, 0, 0, sy, 0, 0])); }
  rotate(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return this.multiply(new Matrix([c, s, -s, c, 0, 0])); }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) throw new Error('not invertible');
    const r = new Matrix();
    r._set(this.d / det, -this.b / det, -this.c / det, this.a / det, (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
    return r;
  }
  invertSelf() { const inv = this.inverse(); this._set(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f); return this; }
  transformPoint(p) { return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f }; }
  toFloat32Array() { return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f]); }
  toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
}
globalThis.DOMMatrix = Matrix;

// ---------------------------------------------------------------
// pdfjs-dist (lazy ESM import)
// ---------------------------------------------------------------
const PDFJS_PATH = pathToFileURL(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
let pdfjsPromise = null;
function getPdfjs() {
  return pdfjsPromise || (pdfjsPromise = import(PDFJS_PATH));
}

const TESSDATA = path.join(__dirname, '..', 'tessdata');

// ---------------------------------------------------------------
// OCR worker cache
// ---------------------------------------------------------------
const workerCache = new Map();
async function getWorker(langKey) {
  if (workerCache.has(langKey)) return workerCache.get(langKey);
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker(langKey, 1, {
    langPath: TESSDATA,
    cachePath: TESSDATA,
    gzip: false,
  });
  workerCache.set(langKey, worker);
  return worker;
}

// ---------------------------------------------------------------
// PNG encoder (for feeding decoded pixels to OCR)
// ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// kind: 1 = grayscale, 2 = RGB, 3 = RGBA
function encodePng(width, height, kind, data) {
  let colorType, bpp;
  if (kind === 1) { colorType = 0; bpp = 1; }
  else if (kind === 2) { colorType = 2; bpp = 3; }
  else { colorType = 6; bpp = 4; }

  const src = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;         // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------
// PDF analysis: text + decoded images per page
// ---------------------------------------------------------------
function getImageObj(objs, name) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('图片解析超时')); } }, 60000);
    try {
      objs.get(name, (d) => { if (!done) { done = true; clearTimeout(t); resolve(d); } });
    } catch (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
  });
}

function largestImage(images) {
  let best = null;
  for (const img of images) {
    if (!best || img.width * img.height > best.width * best.height) best = img;
  }
  return best;
}

async function analyzePdf(buffer) {
  const { getDocument, OPS } = await getPdfjs();
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) {
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      const images = [];
      try {
        const opList = await page.getOperatorList();
        for (let i = 0; i < opList.fnArray.length; i++) {
          const fn = opList.fnArray[i];
          if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject) {
            const name = opList.argsArray[i][0];
            const img = await getImageObj(page.objs, name);
            if (img && img.data && img.width && img.height) {
              images.push({ width: img.width, height: img.height, kind: img.kind, data: img.data });
            }
          }
        }
      } catch (e) { /* image extraction failure is non-fatal */ }
      pages.push({ text, images });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

// ---------------------------------------------------------------
// OCR
// ---------------------------------------------------------------
function scoreResult(data) {
  const conf = typeof data.confidence === 'number' ? data.confidence : 0;
  const text = data.text || '';
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]{2,}/g) || []).length;
  return conf + (cjk + latin) * 0.1;
}

async function ocrImages(images, langKey, onProgress) {
  const worker = await getWorker(langKey);
  const ROT = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

  const firstPng = encodePng(images[0].width, images[0].height, images[0].kind, images[0].data);

  let best = { rad: 0, score: -1, text: '' };
  for (const rad of ROT) {
    if (onProgress) onProgress('正在检测页面方向…');
    const { data } = await worker.recognize(firstPng, { rotateRadians: rad });
    const s = scoreResult(data);
    if (s > best.score) best = { rad, score: s, text: data.text };
  }

  const parts = [best.text];
  for (let p = 1; p < images.length; p++) {
    if (onProgress) onProgress(`正在识别第 ${p + 1} / ${images.length} 页…`);
    const png = encodePng(images[p].width, images[p].height, images[p].kind, images[p].data);
    const { data } = await worker.recognize(png, { rotateRadians: best.rad });
    parts.push(data.text);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------
// Build .docx from text
// ---------------------------------------------------------------
async function textToDocx(text) {
  const lines = text.split(/\r?\n/);
  const children = [];
  for (const line of lines) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) children.push(new Paragraph({ children: [new TextRun({ text: t })] }));
  }
  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: '(未识别到文字内容)' })] }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------
async function convertPdf(buffer, lang, onProgress) {
  const langKey = lang === 'eng' ? 'eng' : lang === 'chi_sim' ? 'chi_sim' : 'chi_sim+eng';

  if (onProgress) onProgress('正在解析 PDF…');
  let pages;
  try {
    pages = await analyzePdf(buffer);
  } catch (e) {
    const msg = String(e.message || e);
    if (/password/i.test(msg)) {
      throw new Error('该 PDF 已加密，请先解除密码后再转换。');
    }
    throw new Error('PDF 解析失败，文件可能已损坏。' + msg);
  }

  const results = [];
  let scannedCount = 0;
  let hasContent = false;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageText = (page.text || '').trim();

    if (pageText.replace(/\s/g, '').length >= 5) {
      results.push(pageText);
      hasContent = true;
    } else {
      const img = largestImage(page.images);
      if (img && img.width * img.height >= 400) {
        if (onProgress) onProgress(`第 ${i + 1} 页为扫描图片，正在 OCR 识别…`);
        const txt = await ocrImages([img], langKey, onProgress);
        results.push(txt);
        scannedCount++;
        if (txt.replace(/\s/g, '').length > 0) hasContent = true;
      }
    }
  }

  if (!hasContent) {
    throw new Error('未能从该 PDF 提取到文字或图片内容。文件可能已加密、为空白页，或内容格式无法解析。');
  }

  if (onProgress) onProgress('正在生成 Word 文档…');
  const docxBuf = await textToDocx(results.join('\n\n'));
  return { docxBuf, isScanned: scannedCount > 0 };
}

module.exports = { convertPdf };
