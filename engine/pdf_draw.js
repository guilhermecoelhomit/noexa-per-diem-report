// Drawing shared by the PDF builders (pdf_perdiem.js, pdf_expenses.js): Carlito embedded with
// pdf-lib, text shaped by fontkit (kerning, ligatures, as Chromium/HarfBuzz) and written with TJ so
// the kerning survives, and the ops of layout.js painted on a page.
//   pdfDraw.setup(PDFLib, fontkit, doc, withItalic) -> Promise<{regular, bold, italic?, clean(s), measure(text, bold, px),
//     paint(page, ops, images)}>
// clean(s): what Carlito cannot draw (in both weights) becomes "?" (never a failed or blank PDF);
// NFC first, so accents are single glyphs. Italic text (op.italic) is Carlito Italic (the local
// app prints Calibri Italic).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./fonts.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.pdfDraw = factory(ns.fonts);
  }
})(typeof self !== "undefined" ? self : this, function (fonts) {
  "use strict";

  function fromBase64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesOf(v) { return typeof v === "string" ? fromBase64(v) : v; }
  function hex4(n) { return ("0000" + n.toString(16).toUpperCase()).slice(-4); }

  function cleaner(fkFonts) {
    return function (s) {
      return Array.from(String(s).normalize("NFC")).map(function (c) {
        var cp = c.codePointAt(0);
        return fkFonts.every(function (f) { return f.hasGlyphForCodePoint(cp); }) ? c : "?";
      }).join("");
    };
  }

  // The glyph's code in pdf-lib's subset font (what CustomFontSubsetEmbedder.encodeText does for
  // a whole string, done per glyph so the kerning from fontkit's layout can go between them).
  function glyphCode(pdfFont, glyph) {
    var e = pdfFont.embedder;
    if (!e || !e.subset || !e.glyphIdMap || !e.glyphs || !e.glyphCache) {
      throw new Error("Unsupported pdf-lib version (subset font internals).");
    }
    var id = e.subset.includeGlyph(glyph);
    e.glyphs[id - 1] = glyph;
    e.glyphIdMap.set(glyph.id, id);
    e.glyphCache.invalidate();
    return hex4(id);
  }

  // One text run as BT ... [<glyphs> kern <glyphs> ...] TJ ET.
  function textOperators(PL, page, fontKey, pdfFont, op, pageH) {
    var fk = pdfFont.embedder.font, run = fk.layout(op.text), k = 1000 / fk.unitsPerEm;
    var items = [], hex = "";
    function flush() { if (hex) { items.push(PL.PDFHexString.of(hex)); hex = ""; } }
    run.glyphs.forEach(function (g, i) {
      var pos = run.positions[i];
      if (pos.xOffset) { flush(); items.push(PL.PDFNumber.of(-pos.xOffset * k)); }
      hex += glyphCode(pdfFont, g);
      var adj = pos.xAdvance - g.advanceWidth - pos.xOffset;
      if (adj) { flush(); items.push(PL.PDFNumber.of(-adj * k)); }
    });
    flush();
    var c = op.color;
    return [
      PL.pushGraphicsState(),
      PL.setFillingColor(PL.rgb(c[0] / 255, c[1] / 255, c[2] / 255)),
      PL.beginText(),
      PL.setFontAndSize(fontKey, op.size),
      PL.setCharacterSpacing(op.spacing || 0),
      PL.setTextMatrix(1, 0, 0, 1, op.x, pageH - op.y),
      PL.PDFOperator.of(PL.PDFOperatorNames.ShowTextAdjusted, [page.doc.context.obj(items)]),
      PL.endText(),
      PL.popGraphicsState()
    ];
  }

  async function setup(PL, fontkit, doc, withItalic) {
    var embedded = await fonts.embed(PL, fontkit, doc, withItalic), regular = embedded.regular, bold = embedded.bold, italic = embedded.italic;
    var clean = cleaner([regular.embedder.font, bold.embedder.font]);
    function measure(text, isBold, size) {
      var f = (isBold ? bold : regular).embedder.font, run = f.layout(text), w = 0;
      run.positions.forEach(function (p) { w += p.xAdvance; });
      return w * size / f.unitsPerEm;
    }
    // ops: layout.js ops in pt, origin top-left; images: {name: PDFImage}
    function paint(page, ops, images) {
      var pageH = page.getHeight();
      var keys = { regular: page.node.newFontDictionary(regular.name, regular.ref),
                   bold: page.node.newFontDictionary(bold.name, bold.ref),
                   italic: italic ? page.node.newFontDictionary(italic.name, italic.ref) : null };
      ops.forEach(function (op) {
        if (op.t === "rect") {
          var c = op.color;
          page.drawRectangle({ x: op.x, y: pageH - op.y - op.h, width: op.w, height: op.h,
                               color: PL.rgb(c[0] / 255, c[1] / 255, c[2] / 255), borderWidth: 0 });
        } else if (op.t === "image") {
          page.drawImage(images[op.name], { x: op.x, y: pageH - op.y - op.h, width: op.w, height: op.h });
        } else {
          if (op.italic && !italic) throw new Error("Italic text needs pdfDraw.setup(..., withItalic = true).");
          var kind = op.italic ? "italic" : op.bold ? "bold" : "regular";
          page.pushOperators.apply(page, textOperators(PL, page, keys[kind],
            kind === "italic" ? italic : kind === "bold" ? bold : regular, op, pageH));
        }
      });
    }
    return { regular: regular, bold: bold, italic: italic, clean: clean, measure: measure, paint: paint };
  }

  return { setup: setup, fromBase64: fromBase64, bytesOf: bytesOf };
});
