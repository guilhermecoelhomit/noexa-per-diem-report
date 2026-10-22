// The Per Diem Report PDF, drawn in vector with pdf-lib (one A4 page), laid out by layout.js so it
// matches the PDF the local app prints with Edge (tests/test_web_parity.py).
//   pdfPerDiem.build(profile, trips, year, month, signaturePng|null, {config}) -> Promise<Uint8Array>
//   signaturePng: Uint8Array or base64 string (the router passes base64). Trips: see preview.js.
// Fonts and text: pdf_draw.js (Carlito, subset-embedded, kerned; a missing glyph is drawn as "?").
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(function () { return require("../vendor/pdf-lib.min.js"); },
      function () { return require("../vendor/fontkit.umd.min.js"); },
      require("./assets.js"), require("./pdf_draw.js"), require("./preview.js"), require("./layout.js"), require("./config.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.pdfPerDiem = factory(function () { return root.PDFLib; }, function () { return root.fontkit; },
      ns.assets, ns.pdfDraw, ns.preview, ns.layout, ns.config);
  }
})(typeof self !== "undefined" ? self : this, function (getPdfLib, getFontkit, assets, pdfDraw, preview, layout, defaultConfig) {
  "use strict";

  function cleanModel(m, clean) {
    var out = {};
    Object.keys(m).forEach(function (k) {
      var v = m[k];
      if (typeof v === "string") out[k] = clean(v);
      else if (k === "cells") out[k] = v.map(function (row) { return row.map(clean); });
      else if (k === "headers") out[k] = v.map(clean);
      else out[k] = v;
    });
    return out;
  }

  async function build(profile, trips, year, month, signaturePng, opts) {
    opts = opts || {};
    var PL = getPdfLib(), fontkit = getFontkit();
    if (!PL || !fontkit) throw new Error("pdf-lib and fontkit must be loaded before pdf_perdiem.js is used.");
    var cfg = opts.config || defaultConfig;
    var model = preview.perDiemModel(profile, trips, year, month, cfg);

    var doc = await PL.PDFDocument.create();
    var draw = await pdfDraw.setup(PL, fontkit, doc);
    var m = cleanModel(model, draw.clean);

    var logo = await doc.embedPng(pdfDraw.fromBase64(assets.logoPng));
    var sig = signaturePng ? await doc.embedPng(pdfDraw.bytesOf(signaturePng)) : null;
    var lay = layout.perDiem(m, draw.measure, { logo: { w: logo.width, h: logo.height },
      signature: sig ? { w: sig.width, h: sig.height } : null });

    var page = doc.addPage([lay.width, lay.height]);
    draw.paint(page, lay.ops, { logo: logo, signature: sig });
    doc.setTitle("Per Diem Report - " + m.monthLabel);
    doc.setCreator("Per Diem Report (web edition)");
    doc.setProducer("pdf-lib");
    return doc.save();
  }

  return { build: build };
});
