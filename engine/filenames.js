// Report file names (reference: perdiem/profile.py::file_stem, perdiem/storage.py::report_stem).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.PerDiemEngine = root.PerDiemEngine || {}).filenames = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var STEM_MAX = 40;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var KINDS = { perdiem: "PerDiem", expenses: "Expenses" };

  // "Zoe  da-Silva Jr." -> "ZoeDaSilvaJr" (accents removed); null when fewer than 2 letters A-Z remain.
  function stem(name) {
    var ascii = String(name).normalize("NFKD").replace(/\p{M}/gu, "");
    var words = ascii.split(/[^A-Za-z0-9]+/).filter(function (w) { return w; });
    var s = words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join("").slice(0, STEM_MAX);
    return (s.match(/[A-Za-z]/g) || []).length < 2 ? null : s;
  }

  function pdfName(stemText, kind, year, month) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new Error("Unknown report kind: " + kind);
    var yy = String(year % 100);
    if (yy.length < 2) yy = "0" + yy;
    return stemText + "_" + KINDS[kind] + "_" + MONTHS[month - 1] + yy + ".pdf";
  }

  return { stem: stem, pdfName: pdfName };
});
