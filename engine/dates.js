// Calendar arithmetic without Date (no time zones, no DST). Dates are {y, m, d}.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.PerDiemEngine = root.PerDiemEngine || {}).dates = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/; // [0-9], not \d: ASCII digits only

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  function monthLength(y, m) {
    if (m === 2) return isLeap(y) ? 29 : 28;
    return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
  }

  // Only "YYYY-MM-DD" (ASCII) naming a real calendar day (year >= 1); anything else -> null.
  function parseIso(s) {
    if (typeof s !== "string") return null;
    var r = ISO.exec(s);
    if (!r) return null;
    var y = +r[1], m = +r[2], d = +r[3];
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > monthLength(y, m)) return null;
    return { y: y, m: m, d: d };
  }

  // Days since 1970-01-01 (proleptic Gregorian, H. Hinnant's days_from_civil).
  function dayNumber(dt) {
    var y = dt.m <= 2 ? dt.y - 1 : dt.y;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * (dt.m + (dt.m > 2 ? -3 : 9)) + 2) / 5) + dt.d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function fromDayNumber(z) {
    z += 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp < 10 ? mp + 3 : mp - 9;
    return { y: m <= 2 ? y + 1 : y, m: m, d: d };
  }

  function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }
  function addDays(dt, n) { return fromDayNumber(dayNumber(dt) + n); }

  return { parseIso: parseIso, monthLength: monthLength, isLeap: isLeap, dayNumber: dayNumber,
           fromDayNumber: fromDayNumber, daysBetween: daysBetween, addDays: addDays };
});
