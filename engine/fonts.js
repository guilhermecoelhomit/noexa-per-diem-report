// Carlito for pdf-lib, shared by the PDF builders.
//   fonts.embed(PDFLib, fontkit, doc, withItalic) -> Promise<{regular, bold, italic?}> (PDFFont, subset-embedded;
//     the italic only when asked for: pdf-lib embeds every registered font, used or not)
//   fonts.padGlyphs(ttfBytes) -> Uint8Array (exported for tests)
//
// Why padGlyphs: fontkit 1.1.1's subsetter writes a short `loca` table (offsets / 2) without
// padding the glyph records, so every glyph after an odd-length record is lost (Carlito has 1312
// of them: only a couple of letters were drawn). Before embedding, the glyph records are padded to
// 4 bytes in memory (long `loca`); outlines, metrics and every other table are unchanged and the
// vendored font files stay exactly as published (SIL OFL 1.1).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./assets.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.fonts = factory(ns.assets);
  }
})(typeof self !== "undefined" ? self : this, function (assets) {
  "use strict";

  function fromBase64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function checksum(bytes, off, len) {
    var sum = 0;
    for (var i = 0; i < len; i += 4) {
      var word = 0;
      for (var j = 0; j < 4; j++) word = (word * 256) + (i + j < len ? bytes[off + i + j] : 0);
      sum = (sum + word) % 4294967296;
    }
    return sum;
  }

  function padGlyphs(src) {
    var dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    var numTables = dv.getUint16(4), tables = {}, order = [], i;
    for (i = 0; i < numTables; i++) {
      var rec = 12 + 16 * i;
      var tag = String.fromCharCode(src[rec], src[rec + 1], src[rec + 2], src[rec + 3]);
      tables[tag] = { offset: dv.getUint32(rec + 8), length: dv.getUint32(rec + 12) };
      order.push(tag);
    }
    if (!tables.glyf || !tables.loca || !tables.head || !tables.maxp) return src; // not a glyf font
    var longLoca = dv.getInt16(tables.head.offset + 50) === 1;
    var numGlyphs = dv.getUint16(tables.maxp.offset + 4);
    function loca(g) {
      return longLoca ? dv.getUint32(tables.loca.offset + 4 * g) : dv.getUint16(tables.loca.offset + 2 * g) * 2;
    }
    var parts = [], offsets = [0], size = 0;
    for (var g = 0; g < numGlyphs; g++) {
      var a = loca(g), b = loca(g + 1), len = b - a, padded = (len + 3) & ~3;
      var chunk = new Uint8Array(padded);
      chunk.set(src.subarray(tables.glyf.offset + a, tables.glyf.offset + b));
      parts.push(chunk);
      size += padded;
      offsets.push(size);
    }
    var glyf = new Uint8Array(size), p = 0;
    parts.forEach(function (c) { glyf.set(c, p); p += c.length; });
    var locaBytes = new Uint8Array(4 * (numGlyphs + 1)), ldv = new DataView(locaBytes.buffer);
    offsets.forEach(function (o, k) { ldv.setUint32(4 * k, o); });
    var head = src.slice(tables.head.offset, tables.head.offset + tables.head.length);
    new DataView(head.buffer).setInt16(50, 1);         // indexToLocFormat: long
    new DataView(head.buffer).setUint32(8, 0);         // checkSumAdjustment, recomputed below

    var data = {};
    order.forEach(function (t) {
      data[t] = t === "glyf" ? glyf : t === "loca" ? locaBytes : t === "head" ? head
        : src.subarray(tables[t].offset, tables[t].offset + tables[t].length);
    });
    var headerLen = 12 + 16 * numTables, total = headerLen;
    order.forEach(function (t) { total += (data[t].length + 3) & ~3; });
    var out = new Uint8Array(total), odv = new DataView(out.buffer);
    out.set(src.subarray(0, 12));
    var at = headerLen;
    order.forEach(function (t, k) {
      var rec2 = 12 + 16 * k, d = data[t];
      for (var c = 0; c < 4; c++) out[rec2 + c] = t.charCodeAt(c);
      out.set(d, at);
      odv.setUint32(rec2 + 4, checksum(out, at, d.length));
      odv.setUint32(rec2 + 8, at);
      odv.setUint32(rec2 + 12, d.length);
      at += (d.length + 3) & ~3;
    });
    var headAt = odv.getUint32(12 + 16 * order.indexOf("head") + 8);
    odv.setUint32(headAt + 8, (0xB1B0AFBA - checksum(out, 0, out.length) + 4294967296) % 4294967296);
    return out;
  }

  var padded = {}; // the padded bytes by face, made once per page load and only for faces that are used
  function paddedFace(key, asset) {
    if (!padded[key]) padded[key] = padGlyphs(fromBase64(asset));
    return padded[key];
  }
  async function embed(PL, fontkit, doc, withItalic) {
    doc.registerFontkit(fontkit);
    var out = {
      regular: await doc.embedFont(paddedFace("regular", assets.carlitoRegular), { subset: true }),
      bold: await doc.embedFont(paddedFace("bold", assets.carlitoBold), { subset: true })
    };
    if (withItalic) out.italic = await doc.embedFont(paddedFace("italic", assets.carlitoItalic), { subset: true });
    return out;
  }

  return { embed: embed, padGlyphs: padGlyphs };
});
