// Engine defaults. The user-editable file is web/config.js (loaded after this one): it overrides
// the values on PerDiemEngine.config. No personal data lives here (profile and signature are asked
// for in every session).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.config = factory(ns.config);
  }
})(typeof self !== "undefined" ? self : this, function (existing) {
  "use strict";
  var defaults = {
    unit_rate: "0.40",           // EUR per km
    company: "NoeXa",            // "Company" column of the Per Diem Report
    goal: "Travel to client site" // "Trip Business Goal" column
  };
  // Browser: keep anything web/config.js set before this script ran.
  if (existing) for (var k in defaults) if (!(k in existing)) existing[k] = defaults[k];
  return existing || defaults;
});
