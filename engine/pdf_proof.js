// PDF proofs in the web edition, with pdf-lib: the checks of perdiem/proofs.py::_check_pdf (at
// upload) and the copy of the proof's pages into the report after the allow-list rebuild of
// perdiem/assemble.py::_sanitise_page (at save). Same limits and the same English messages.
//   pdfProof.inspect(bytes) -> Promise<{pages}>; rejects with {status: 422, message}:
//     encrypted (any algorithm) -> MSG_ENCRYPTED; not loadable by pdf-lib, no pages -> MSG_UNREADABLE;
//     over 30 pages -> MSG_TOO_MANY. pdf-lib is less tolerant than pypdf: a file it cannot load, or
//     whose pages it cannot copy and write back (a trial copy is made here), is refused as
//     unreadable at upload, so the report is never left with a broken page.
//   pdfProof.pages(PDFLib, targetDoc, bytes, expectedPages) -> Promise<PDFPage[]> (copied into
//     targetDoc, not yet added): the source pages are sanitised BEFORE pdf-lib copies them, so a
//     hostile object is never copied into the report. Rejects with a MergeError {name: "MergeError",
//     message} carrying assemble.py's texts: "A proof PDF could not be merged: encrypted |
//     unreadable | too many pages | <error type>", or MSG_LAYOUT when the page count differs from
//     the one checked at upload.
// Sanitising (assemble._sanitise_page): the page keys /AA /PresSteps /Trans /Dur /Thumb /PieceInfo
// /Metadata /Actions /B are removed; /Annots is replaced by NEW dictionaries for the allow-listed
// subtypes only, carrying only plain data (numbers, names, strings, booleans, arrays of those,
// references resolved) for the allow-listed keys, /BS rebuilt from its allowed keys and /AP
// reduced to its normal appearance /N. Anything that cannot be resolved or classified is dropped
// (fail closed); a malformed /Annots is dropped entirely. Links, attachments, JavaScript/Launch
// actions and form values (/V) of the proof never reach the report; the document's /OpenAction
// and names are never copied (only pages are). As in the local app, /Resources, /AP /N streams
// and the other page keys are copied as they are (residual risk: docs/decisions.md).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(function () { return require("../vendor/pdf-lib.min.js"); });
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.pdfProof = factory(function () { return root.PDFLib; });
  }
})(typeof self !== "undefined" ? self : this, function (getPdfLib) {
  "use strict";
  var MAX_PDF_PAGES = 30;
  var MSG_ENCRYPTED = "This PDF is encrypted. Open it and use Print → Save as PDF, then attach the new file.";
  var MSG_UNREADABLE = "This PDF could not be read.";
  var MSG_TOO_MANY = "This PDF has too many pages (maximum " + MAX_PDF_PAGES + ").";
  var MSG_LAYOUT = "The proof pages could not be laid out (page count mismatch).";
  var MSG_MERGE = "A proof PDF could not be merged: ";

  var ALLOWED_ANNOTS = ["/Widget", "/Highlight", "/Underline", "/StrikeOut", "/Squiggly", "/Square", "/Circle",
    "/Line", "/Polygon", "/PolyLine", "/Ink", "/Stamp", "/FreeText", "/Text"];
  var ANNOT_PLAIN_KEYS = ["Type", "Subtype", "Rect", "F", "C", "CA", "QuadPoints", "Border",
    "InkList", "L", "Vertices", "Contents", "DA", "Q", "Name", "AS"];
  var BS_KEYS = ["Type", "W", "S", "D"];
  var PAGE_DROP_KEYS = ["AA", "PresSteps", "Trans", "Dur", "Thumb", "PieceInfo", "Metadata", "Actions", "B"];

  function InspectError(message) { this.status = 422; this.message = message; }
  InspectError.prototype = Object.create(Error.prototype);
  InspectError.prototype.name = "PdfProofError";
  function MergeError(message) { this.message = message; }
  MergeError.prototype = Object.create(Error.prototype);
  MergeError.prototype.name = "MergeError";

  function PL() {
    var lib = getPdfLib();
    if (!lib) throw new Error("pdf-lib must be loaded before pdf_proof.js is used.");
    return lib;
  }

  function load(lib, bytes) {
    return lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  }

  // assemble._plain: a deep copy of plain data with references resolved; anything else throws.
  function plain(lib, ctx, value, depth) {
    var v = value instanceof lib.PDFRef ? ctx.lookup(value) : value;
    if (depth > 4) throw new Error("too deep");
    if (v instanceof lib.PDFArray) {
      var out = lib.PDFArray.withContext(ctx);
      v.asArray().forEach(function (x) { out.push(plain(lib, ctx, x, depth + 1)); });
      return out;
    }
    if (v instanceof lib.PDFName || v instanceof lib.PDFNumber || v instanceof lib.PDFBool ||
        v instanceof lib.PDFString || v instanceof lib.PDFHexString) return v;
    throw new Error("unsupported value");
  }

  function nameText(v) { return "/" + v.decodeText(); }

  // assemble._clean_annotation: a NEW dictionary of an allow-listed annotation, or null.
  function cleanAnnotation(lib, ctx, ref) {
    var a = ref instanceof lib.PDFRef ? ctx.lookup(ref) : ref;
    if (!(a instanceof lib.PDFDict)) return null;
    var st = a.get(lib.PDFName.of("Subtype"));
    st = st instanceof lib.PDFRef ? ctx.lookup(st) : st;
    if (!(st instanceof lib.PDFName) || ALLOWED_ANNOTS.indexOf(nameText(st)) < 0) return null;
    var out = lib.PDFDict.withContext(ctx);
    ANNOT_PLAIN_KEYS.forEach(function (k) {
      var key = lib.PDFName.of(k);
      if (a.has(key)) out.set(key, plain(lib, ctx, a.get(key), 0));
    });
    out.set(lib.PDFName.of("Subtype"), lib.PDFName.of(st.decodeText()));
    if (!out.has(lib.PDFName.of("Rect"))) return null;
    var bs = a.lookup(lib.PDFName.of("BS"));
    if (bs instanceof lib.PDFDict) {
      var nb = lib.PDFDict.withContext(ctx);
      BS_KEYS.forEach(function (k) {
        var key = lib.PDFName.of(k);
        if (bs.has(key)) nb.set(key, plain(lib, ctx, bs.get(key), 0));
      });
      out.set(lib.PDFName.of("BS"), nb);
    }
    var ap = a.lookup(lib.PDFName.of("AP"));
    if (ap instanceof lib.PDFDict && ap.has(lib.PDFName.of("N"))) {
      var na = lib.PDFDict.withContext(ctx);
      na.set(lib.PDFName.of("N"), ap.get(lib.PDFName.of("N")));
      out.set(lib.PDFName.of("AP"), na);
    }
    return out;
  }

  // assemble._sanitise_page, on the SOURCE page node (before it is copied).
  function sanitise(lib, doc, page) {
    var node = page.node, ctx = doc.context, ANNOTS = lib.PDFName.of("Annots");
    PAGE_DROP_KEYS.forEach(function (k) { node.delete(lib.PDFName.of(k)); });
    if (!node.has(ANNOTS)) return;
    var keep = lib.PDFArray.withContext(ctx);
    try {
      var items = node.lookup(ANNOTS);
      if (items instanceof lib.PDFArray) {
        items.asArray().forEach(function (ref) {
          var clean = null;
          try { clean = cleanAnnotation(lib, ctx, ref); } catch (e) { clean = null; }
          if (clean !== null) keep.push(clean);
        });
      }
    } catch (e) {
      keep = lib.PDFArray.withContext(ctx);
    }
    if (keep.size()) node.set(ANNOTS, keep);
    else node.delete(ANNOTS);
  }

  // The proof's pages, sanitised and copied into target (assemble._proof_pages + _merge).
  async function pages(lib, target, bytes, expected) {
    lib = lib || PL();
    var src;
    try {
      src = await load(lib, bytes);
    } catch (e) {
      throw new MergeError(MSG_MERGE + "unreadable");
    }
    if (src.isEncrypted) throw new MergeError(MSG_MERGE + "encrypted");
    var list;
    try { list = src.getPages(); } catch (e) { throw new MergeError(MSG_MERGE + "unreadable"); }
    if (list.length < 1) throw new MergeError(MSG_MERGE + "unreadable");
    if (list.length > MAX_PDF_PAGES) throw new MergeError(MSG_MERGE + "too many pages");
    if (expected != null && list.length !== expected) throw new MergeError(MSG_LAYOUT);
    try {
      list.forEach(function (p) { sanitise(lib, src, p); });
      return await target.copyPages(src, list.map(function (_, i) { return i; }));
    } catch (e) {
      // The error's type only, never its message (as assemble._merge_error(type(e).__name__)).
      var kind = e && typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
      throw new MergeError(MSG_MERGE + kind);
    }
  }

  // proofs._check_pdf, then a trial copy: what pdf-lib cannot copy and write back is unreadable.
  async function inspect(bytes) {
    var lib = PL(), doc, count;
    try {
      doc = await load(lib, bytes);
    } catch (e) {
      throw new InspectError(MSG_UNREADABLE);
    }
    if (doc.isEncrypted) throw new InspectError(MSG_ENCRYPTED);
    try { count = doc.getPageCount(); } catch (e) { throw new InspectError(MSG_UNREADABLE); }
    if (count < 1) throw new InspectError(MSG_UNREADABLE);
    if (count > MAX_PDF_PAGES) throw new InspectError(MSG_TOO_MANY);
    try {
      var trial = await lib.PDFDocument.create();
      (await pages(lib, trial, bytes, count)).forEach(function (p) { trial.addPage(p); });
      var back = await lib.PDFDocument.load(await trial.save({ useObjectStreams: false }));
      if (back.getPageCount() !== count) throw new Error("page count");
    } catch (e) {
      throw new InspectError(MSG_UNREADABLE);
    }
    return { pages: count };
  }

  return { inspect: inspect, pages: pages, sanitise: sanitise, MergeError: MergeError,
    MAX_PDF_PAGES: MAX_PDF_PAGES, MSG_ENCRYPTED: MSG_ENCRYPTED, MSG_UNREADABLE: MSG_UNREADABLE,
    MSG_TOO_MANY: MSG_TOO_MANY, MSG_LAYOUT: MSG_LAYOUT, MSG_MERGE: MSG_MERGE };
});
