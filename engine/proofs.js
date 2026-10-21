// The proof store of the web edition: in memory, for this page only (nothing is ever written
// anywhere). The checks, limits and English messages are those of perdiem/proofs.py and of the
// local server's upload route (perdiem/server.py, POST /api/expenses/proof).
//   proofs.createStore({env, random}) -> store
//     env: the image env of images.js (default: the browser's); random(n) -> Uint8Array of n
//     random bytes (default: crypto.getRandomValues).
//   store.add({name, bytes: Uint8Array}) -> Promise<{id, name, kind: "image"|"pdf", size, pages}>
//     id: 32 random hex digits; size: the real byte count of the file; pages: 1 for an image, the
//     PDF's page count (1..30) for a PDF. The type comes from the content (JPEG/PNG magic bytes, or
//     "%PDF-" in the first 1024 bytes), never from the name. Refusals reject with a ProofError
//     {status, message}: 413 over 8 MiB, 422 empty / unknown type / unreadable image / over 40 MP /
//     encrypted, unreadable, empty or over 30-page PDF (pdf_proof.inspect). Nothing is stored when
//     refused.
//   store.get(id) -> {name, kind, pages, size} | null   (what the router reads for an invoice)
//   store.image(id) -> {bytes, type, width, height, naturalWidth, naturalHeight} | null
//     (images.prepare's result: the image the PDF draws)
//   store.pdf(id) -> Uint8Array | null (a copy of the PDF proof's bytes, as uploaded)
//   store.size() -> number of proofs held
// The 25 000 000-byte total is a rule of the report (the invoices that use the proofs), as in the
// local app: the page checks it before uploading (logic.proofBudgetIssue) and the router checks
// it again when the PDF is made (/api/expenses/save), with the same message.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./images.js"), require("./pdf_proof.js"), root);
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.proofs = factory(ns.images, ns.pdfProof, root);
  }
})(typeof self !== "undefined" ? self : this, function (images, pdfProof, root) {
  "use strict";
  var MAX_PROOF_BYTES = 8 * 1024 * 1024;
  var MAX_TOTAL_PROOF_BYTES = 25 * 1000 * 1000;
  var MAX_NAME = 255;
  var ID_RE = /^[0-9a-f]{32}$/;
  var MSG_TYPE = "Unsupported file type. Use JPG, PNG or PDF.";
  var MSG_TOO_BIG = "The file is too large (maximum 8 MB).";
  var MSG_TOTAL = "Proofs exceed 25 MB in total.";
  var MSG_EXPIRED = "A proof file expired; attach it again.";

  function ProofError(status, message) {
    this.status = status; this.message = message;
  }
  ProofError.prototype = Object.create(Error.prototype);
  ProofError.prototype.name = "ProofError";

  // proofs.normalise_name: the base name, control/format/line/paragraph separators removed,
  // other spaces collapsed to one, at most 255 characters (the extension kept when it can be).
  function normaliseName(filename) {
    var name = String(filename).replace(/\\/g, "/");
    name = name.slice(name.lastIndexOf("/") + 1);
    name = Array.from(name).filter(function (c) { return !/^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u.test(c); })
      .map(function (c) { return /^\p{Zs}$/u.test(c) ? " " : c; }).join("");
    name = name.split(" ").filter(function (s) { return s; }).join(" ");
    if (name === "" || name === "." || name === "..") return "proof";
    var chars = Array.from(name);
    if (chars.length > MAX_NAME) {
      var dot = name.lastIndexOf(".");
      var stem = dot >= 0 ? Array.from(name.slice(0, dot)) : [], ext = dot >= 0 ? Array.from(name.slice(dot + 1)) : [];
      if (dot >= 0 && stem.length && ext.length <= 16) {
        name = stem.slice(0, MAX_NAME - ext.length - 1).join("").replace(/\s+$/u, "") + "." + ext.join("");
      } else {
        name = chars.slice(0, MAX_NAME).join("");
      }
    }
    return name;
  }

  function hasPdfMarker(b) {
    var n = Math.min(b.length, 1024);
    for (var i = 0; i + 5 <= n; i++) {
      if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
    }
    return false;
  }

  function defaultRandom(n) {
    var c = root.crypto || (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    if (!c || typeof c.getRandomValues !== "function") throw new Error("No secure random source.");
    return c.getRandomValues(new Uint8Array(n));
  }

  function createStore(opts) {
    opts = opts || {};
    var random = opts.random || defaultRandom, env = opts.env;
    var held = new Map(); // id -> {info, image}

    function newId() {
      for (;;) {
        var id = Array.from(random(16), function (v) { return ("0" + v.toString(16)).slice(-2); }).join("");
        if (ID_RE.test(id) && !held.has(id)) return id;
      }
    }

    async function add(file) {
      var bytes = file && file.bytes;
      if (Object.prototype.toString.call(bytes) !== "[object Uint8Array]") throw new ProofError(400, "Incomplete upload.");
      if (bytes.length > MAX_PROOF_BYTES) throw new ProofError(413, MSG_TOO_BIG);
      var image = null, pdf = null, kind = "image", pages = 1;
      if (images.isJpeg(bytes) || images.isPng(bytes)) {
        try {
          images.check(bytes);                     // header only: 40 MP refused before decoding
          image = await images.prepare(bytes, env);
        } catch (e) {
          throw new ProofError(422, (e && e.message) || images.MSG_UNREADABLE);
        }
      } else if (hasPdfMarker(bytes)) {
        kind = "pdf";
        pdf = bytes.slice();                       // the caller's array may change later
        try {
          pages = (await pdfProof.inspect(pdf)).pages;
        } catch (e) {
          throw new ProofError(422, (e && e.status === 422 && e.message) || pdfProof.MSG_UNREADABLE);
        }
      } else {
        throw new ProofError(422, MSG_TYPE);
      }
      var info = { id: newId(), name: normaliseName(file.name == null ? "" : file.name), kind: kind,
                   size: bytes.length, pages: pages };
      held.set(info.id, { info: info, image: image, pdf: pdf });
      return Object.assign({}, info);
    }

    function entry(id) { return typeof id === "string" && ID_RE.test(id) && held.has(id) ? held.get(id) : null; }

    return {
      add: add,
      get: function (id) {
        var e = entry(id);
        return e ? { name: e.info.name, kind: e.info.kind, pages: e.info.pages, size: e.info.size } : null;
      },
      image: function (id) { var e = entry(id); return e ? e.image : null; },
      pdf: function (id) { var e = entry(id); return e && e.pdf ? e.pdf.slice() : null; },
      size: function () { return held.size; }
    };
  }

  return { createStore: createStore, normaliseName: normaliseName, ProofError: ProofError,
    MAX_PROOF_BYTES: MAX_PROOF_BYTES, MAX_TOTAL_PROOF_BYTES: MAX_TOTAL_PROOF_BYTES,
    MSG_TYPE: MSG_TYPE, MSG_TOO_BIG: MSG_TOO_BIG, MSG_TOTAL: MSG_TOTAL, MSG_EXPIRED: MSG_EXPIRED };
});
