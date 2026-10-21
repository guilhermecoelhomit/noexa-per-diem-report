// The one file to edit when the unit rate or the fixed texts change (same for everyone).
// Loaded after engine/config.js. No personal data here.
(function (root) {
  "use strict";
  var overrides = {
    unit_rate: "0.40"             // EUR per km
    // company: "NoeXa",
    // goal: "Travel to client site"
  };
  var cfg;
  if (typeof module === "object" && module.exports) cfg = require("./engine/config.js");
  else cfg = (root.PerDiemEngine = root.PerDiemEngine || {}).config = (root.PerDiemEngine.config || {});
  for (var k in overrides) cfg[k] = overrides[k];
  if (typeof module === "object" && module.exports) module.exports = cfg;
})(typeof self !== "undefined" ? self : this);
