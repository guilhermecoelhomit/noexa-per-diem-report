// Money in integer cents, ROUND_HALF_UP per line (reference: perdiem/renderer.py::_cents).
// Decimal strings are parsed with BigInt; no floating point is involved. Classic UMD, no DOM.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.PerDiemEngine = root.PerDiemEngine || {}).money = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var PLAIN = /^[+-]?[0-9]+(\.[0-9]+)?$/;

  function pow10(k) { return BigInt("1" + "0".repeat(k)); }

  // "12.50" -> {n: 1250n, s: 2} (value = n / 10^s); null when not a plain finite decimal.
  function parse(v) {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) return null;
      v = String(v);
    }
    if (typeof v !== "string" || !PLAIN.test(v)) return null;
    var neg = v.charAt(0) === "-";
    var body = v.replace(/^[+-]/, "");
    var parts = body.split(".");
    var frac = parts[1] || "";
    var n = BigInt(parts[0] + frac);
    return { n: neg ? -n : n, s: frac.length };
  }

  function align(a, b) {
    var s = Math.max(a.s, b.s);
    return [a.n * pow10(s - a.s), b.n * pow10(s - b.s)];
  }

  // -1 / 0 / 1
  function compare(a, b) {
    var p = align(a, b);
    return p[0] < p[1] ? -1 : p[0] > p[1] ? 1 : 0;
  }

  // Round (n / 10^s) to 2 decimals, ties away from zero, and return the integer count of cents.
  function toCents(d) {
    if (d.s <= 2) return d.n * pow10(2 - d.s);
    var k = d.s - 2, div = pow10(k);
    var neg = d.n < 0n, abs = neg ? -d.n : d.n;
    var q = (abs + div / 2n) / div;
    return neg ? -q : q;
  }

  // cents("10.5", "0.40") -> 420. Without unitRate the value itself is rounded to cents.
  function cents(value, unitRate) {
    var a = parse(value);
    if (a === null) throw new Error("Invalid decimal: " + String(value));
    if (unitRate !== undefined && unitRate !== null) {
      var b = parse(unitRate);
      if (b === null) throw new Error("Invalid decimal: " + String(unitRate));
      a = { n: a.n * b.n, s: a.s + b.s };
    }
    return Number(toCents(a));
  }

  // 123456 -> "1234,56" (no thousands separator, like perdiem.formatting.fmt_eur)
  function format(c) {
    var neg = c < 0, s = String(Math.abs(c));
    while (s.length < 3) s = "0" + s;
    return (neg ? "-" : "") + s.slice(0, -2) + "," + s.slice(-2);
  }

  return { parse: parse, compare: compare, cents: cents, format: format };
});
