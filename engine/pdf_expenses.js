// The Expenses Report PDF, drawn in vector with pdf-lib, laid out by layout.expenses so the report
// pages match the PDF the local app prints with Edge (tests/test_web_parity.py); the proof pages
// follow them.
//   pdfExpenses.build(profile, expenses, invoices, year, month, signaturePng|null, proofPages, {config})
//     -> Promise<Uint8Array>
//   expenses/invoices: as the router parses them (preview.expensesModel); signaturePng: Uint8Array
//   or base64. Sections: Expenses when there are expenses or nothing at all, Invoices only with
//   invoices (the same model as the HTML preview).
//   proofPages: already prepared pages, in order, each one of
//     {title, image}                          an image proof page (layout.imageProof): title
//                                             "Proof for invoice N · name", image = images.prepare's
//                                             result {bytes (JPEG or PNG), naturalWidth, naturalHeight, ...},
//     {title, note, proofPdf, pages}          a PDF proof: its separator page (layout.pdfSeparator:
//                                             title "Proof for invoice N · attached PDF (k pages)",
//                                             note = the file name), then its own `pages` pages,
//                                             sanitised and copied by pdf_proof.pages, or
//     {draw: async function (doc, drawing)}   adds its own page(s) (drawing: pdf_draw.setup's result).
//   A PDF proof that cannot be merged rejects with pdf_proof's MergeError (the router answers 422);
//   with PDF proofs the saved file is loaded back and its page count checked (assemble._merge).
// Fonts and text: pdf_draw.js (Carlito, subset-embedded, kerned; a missing glyph is drawn as "?").
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(function () { return require("../vendor/pdf-lib.min.js"); },
      function () { return require("../vendor/fontkit.umd.min.js"); },
      require("./assets.js"), require("./pdf_draw.js"), require("./preview.js"), require("./layout.js"), require("./config.js"),
      require("./pdf_proof.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.pdfExpenses = factory(function () { return root.PDFLib; }, function () { return root.fontkit; },
      ns.assets, ns.pdfDraw, ns.preview, ns.layout, ns.config, ns.pdfProof);
  }
})(typeof self !== "undefined" ? self : this, function (getPdfLib, getFontkit, assets, pdfDraw, preview, layout, defaultConfig, pdfProof) {
  "use strict";

  // Every text of the model through clean() (strings, lists of strings, rows of strings).
  function cleanModel(m, clean) {
    var out = {};
    Object.keys(m).forEach(function (k) {
      var v = m[k];
      if (typeof v === "string") out[k] = clean(v);
      else if (k === "expenseCells" || k === "invoiceCells") out[k] = v.map(function (row) { return row.map(clean); });
      else if (k === "expenseHeaders" || k === "invoiceHeaders") out[k] = v.map(clean);
      else out[k] = v;
    });
    return out;
  }

  async function build(profile, expenses, invoices, year, month, signaturePng, proofPages, opts) {
    opts = opts || {};
    var PL = getPdfLib(), fontkit = getFontkit();
    if (!PL || !fontkit) throw new Error("pdf-lib and fontkit must be loaded before pdf_expenses.js is used.");
    var cfg = opts.config || defaultConfig;
    var model = preview.expensesModel(profile, expenses, invoices, year, month, cfg);

    var doc = await PL.PDFDocument.create();
    // Carlito Italic is only for the "No entries" text of an empty Expenses table.
    var draw = await pdfDraw.setup(PL, fontkit, doc, !!(model.showExpenses && !model.expenseCells.length));
    var m = cleanModel(model, draw.clean);

    var logo = await doc.embedPng(pdfDraw.fromBase64(assets.logoPng));
    var sig = signaturePng ? await doc.embedPng(pdfDraw.bytesOf(signaturePng)) : null;
    var lay = layout.expenses(m, draw.measure, { logo: { w: logo.width, h: logo.height },
      signature: sig ? { w: sig.width, h: sig.height } : null });
    lay.pages.forEach(function (ops) {
      draw.paint(doc.addPage([lay.width, lay.height]), ops, { logo: logo, signature: sig });
    });

    var withPdf = false;
    for (var i = 0; i < (proofPages || []).length; i++) {
      var src = proofPages[i];
      if (src.image) {
        var img = src.image, b = pdfDraw.bytesOf(img.bytes);
        var embedded = b[0] === 0x89 ? await doc.embedPng(b) : await doc.embedJpg(b);
        var pl = layout.imageProof(draw.clean(src.title), { w: img.naturalWidth || embedded.width,
          h: img.naturalHeight || embedded.height }, draw.measure);
        draw.paint(doc.addPage([pl.width, pl.height]), pl.ops, { proof: embedded });
      } else if (src.proofPdf) {
        withPdf = true;
        var sep = layout.pdfSeparator(draw.clean(src.title), draw.clean(src.note || ""), draw.measure);
        draw.paint(doc.addPage([sep.width, sep.height]), sep.ops, {});
        var copied = await pdfProof.pages(PL, doc, pdfDraw.bytesOf(src.proofPdf), src.pages);
        copied.forEach(function (page) { doc.addPage(page); });
      } else if (typeof src.draw === "function") {
        await src.draw(doc, draw);
      } else {
        throw new Error("Unknown proof page.");
      }
    }
    doc.setTitle("Expenses Report - " + m.monthLabel);
    doc.setCreator("Per Diem Report (web edition)");
    doc.setProducer("pdf-lib");
    var out = await doc.save();
    if (withPdf) {
      var expected = doc.getPageCount(), back;
      try { back = (await PL.PDFDocument.load(out, { updateMetadata: false })).getPageCount(); } catch (e) { back = -1; }
      if (back !== expected) throw new pdfProof.MergeError(pdfProof.MSG_LAYOUT);
    }
    return out;
  }

  return { build: build };
});
