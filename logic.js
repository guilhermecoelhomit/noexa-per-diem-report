// Pure logic (no DOM): money in integer cents, dates as ISO strings, payload building.
(function (root) {
  "use strict";
  var MAX_CENTS = 999999; // 9999.99
  var LIMITS = { project: 20, location: 30 };
  var MAX_KM_HALF = 19999; // 9999.5 km in half-km units
  // Same rule as the server (validator._has_control): Cc, Cf, Zl, Zp, and any space other than U+0020.
  var CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

  // maxCents defaults to 9999.99 (Per Diem); the Expenses Report passes EXPENSE_MAX_CENTS.
  function parseAmount(str, maxCents) {
    if (typeof str !== "string") return null;
    var s = str.trim();
    if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
    var parts = s.replace(",", ".").split(".");
    var frac = parts[1] || "";
    while (frac.length < 2) frac += "0";
    if (parts[0].length > String(Math.floor((maxCents || MAX_CENTS) / 100)).length) return null;
    var cents = parseInt(parts[0], 10) * 100 + parseInt(frac, 10);
    return cents >= 1 && cents <= (maxCents || MAX_CENTS) ? cents : null;
  }

  function formatCents(c) {
    var s = String(c);
    while (s.length < 3) s = "0" + s;
    return s.slice(0, -2) + "," + s.slice(-2);
  }
  function centsToApi(c) { return formatCents(c).replace(",", "."); }
  function clean(s) { return String(s === undefined || s === null ? "" : s).trim(); }
  function textOk(s, max, required) {
    if (required && !s) return false;
    return s.length <= max && !CONTROL.test(s);
  }
  // Project choices are keyed by the trip's stable client key (a trip keeps its choice when others are removed);
  // trips without a key fall back to their number.
  function tkey(t) { return t.key !== undefined ? t.key : t.number; }
  function tripProject(choices, t) {
    var c = choices && choices[tkey(t)];
    return c && c.on ? clean(c.name) : "";
  }
  // "missing" (empty), "invalid" (too long / invisible or non-plain-space characters) or null.
  function projectIssue(name) {
    var s = clean(name);
    if (!s) return "missing";
    return textOk(s, LIMITS.project, true) ? null : "invalid";
  }
  function hasProjectGap(trips, choices) {
    return trips.some(function (t) {
      var c = choices && choices[tkey(t)];
      return !!(c && c.on && projectIssue(c.name) !== null);
    });
  }
  function toPayload(year, month, trips, choices) {
    return {
      year: year,
      month: month,
      trips: trips.map(function (t, i) {
        var o = {};
        Object.keys(t).forEach(function (k) { o[k] = t[k]; });
        o.number = i + 1; // numbers are the position in the list (the server assigns them the same way)
        o.project = tripProject(choices, t);
        o.location = clean(t.location);
        var k = parseKm(t.km);
        if (k.ok) o.km = k.value;
        var d = daysBetween(t.start, t.end);
        if (d !== null) o.days = d; // the server checks start/end/days against each other
        return o;
      })
    };
  }

  // ---- trip km and location (edited by the user; the value km x rate is only computed) ----
  var MSG_KM_FORMAT = "Enter the km, e.g. 1030,5.";
  var MSG_KM_RANGE = "Km must be greater than 0 and at most 9999.5.";
  var MSG_KM_HALF = "Km must be a multiple of 0.5.";
  var MSG_LOCATION = "Location: 1–30 characters, no special spaces.";

  // "1030,5" / "1030.5" / "100" -> {ok:true, value:"1030.5"}; value is the canonical decimal string.
  function parseKm(str) {
    if (typeof str !== "string") return { ok: false, message: MSG_KM_FORMAT };
    var s = str.trim();
    var m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
    if (!m) return { ok: false, message: MSG_KM_FORMAT };
    var int = m[1].replace(/^0+(?=\d)/, ""), frac = (m[2] || "").replace(/0+$/, "");
    if (int.length > 5) return { ok: false, message: MSG_KM_RANGE };
    var half = parseInt(int, 10) * 2 + (frac === "5" ? 1 : 0);
    if (frac !== "" && frac !== "5") return { ok: false, message: MSG_KM_HALF };
    if (half < 1 || half > MAX_KM_HALF) return { ok: false, message: MSG_KM_RANGE };
    return { ok: true, value: int + (frac ? "." + frac : "") };
  }
  function kmHalfUnits(km) {
    var r = parseKm(km);
    return r.ok ? Math.round(parseFloat(r.value) * 2) : null; // exact: value is a multiple of 0.5 below 1e5
  }
  // "0.40" -> 40 (cents per km); null when it is not a plain decimal with at most 2 places.
  function rateToCents(str) {
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(str === undefined || str === null ? "" : str).trim());
    if (!m) return null;
    var frac = m[2] || "";
    while (frac.length < 2) frac += "0";
    return parseInt(m[1], 10) * 100 + parseInt(frac, 10);
  }
  // km x rate in integer cents, rounded half up like the server (km = halfUnits / 2).
  function tripValueCents(km, rateCents) {
    var half = kmHalfUnits(km);
    if (half === null || typeof rateCents !== "number") return null;
    return Math.floor((half * rateCents + 1) / 2);
  }
  function locationOk(location) {
    var loc = clean(location);
    return textOk(loc, LIMITS.location, true) && len(loc) <= LIMITS.location;
  }
  // Km as shown in the field: canonical value with a comma ("1093.0" -> "1093"); other text as typed.
  function kmDisplay(km) {
    var r = parseKm(String(km === undefined || km === null ? "" : km));
    return String(r.ok ? r.value : km === undefined || km === null ? "" : km).replace(".", ",");
  }
  // ---- trip dates (start and end are editable; days = end - start) ----
  var MSG_DATES = "Enter valid start and end dates.";
  var MSG_END_AFTER = "The end date must be after the start date.";
  var MAX_TRIPS = 10;
  function msgMonth(year, month) {
    return "The start and end dates of the trips must fall within the month " + (month < 10 ? "0" : "") + month + "/" + year + ".";
  }
  // Whole days from start to end (negative when end is earlier); null when a date is not a real YYYY-MM-DD.
  function daysBetween(a, b) {
    if (!isoDateOk(a) || !isoDateOk(b)) return null;
    var p = function (s) { var m = s.split("-"); return Date.UTC(+m[0], +m[1] - 1, +m[2]); };
    return Math.round((p(b) - p(a)) / 86400000);
  }
  function dateIssues(t, year, month) {
    var d = daysBetween(t.start, t.end);
    if (d === null) return [MSG_DATES];
    var out = [];
    if (d <= 0) out.push(MSG_END_AFTER);
    if (year && month) {
      var prefix = year + "-" + (month < 10 ? "0" : "") + month + "-";
      if (t.start.indexOf(prefix) !== 0 || t.end.indexOf(prefix) !== 0) out.push(msgMonth(year, month));
    }
    return out;
  }
  function tripIssues(t, year, month) {
    t = t || {};
    var out = [];
    if (t.start !== undefined || t.end !== undefined) out = out.concat(dateIssues(t, year, month));
    if (!locationOk(t.location)) out.push(MSG_LOCATION);
    var k = parseKm(t.km);
    if (!k.ok) out.push(k.message);
    return out;
  }
  // Index pairs [i, j] (i < j) of trips with valid dates that overlap or share a day.
  function overlapPairs(trips) {
    var out = [];
    for (var i = 0; i < trips.length; i++) {
      for (var j = i + 1; j < trips.length; j++) {
        var a = trips[i], b = trips[j];
        if (daysBetween(a.start, a.end) === null || daysBetween(b.start, b.end) === null) continue;
        if (a.start <= b.end && b.start <= a.end) out.push([i, j]);
      }
    }
    return out;
  }
  function msgOverlap(i, j) {
    return "Trips " + (i + 1) + " and " + (j + 1) + " overlap or share a date (trips must not overlap or coincide).";
  }
  // 1 to 10 trips; each valid; no two overlapping (any order of dates is fine; locations may repeat).
  function tripsIssues(trips, year, month) {
    if (!trips.length) return ["Add at least one trip."];
    var out = [];
    if (trips.length > MAX_TRIPS) out.push("At most " + MAX_TRIPS + " trips are allowed.");
    trips.forEach(function (t) { out = out.concat(tripIssues(t, year, month)); });
    overlapPairs(trips).forEach(function (pr) { out.push(msgOverlap(pr[0], pr[1])); });
    return out;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function isoOf(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  // Sensible starting dates for a new trip: five days (Mon-Fri start) after the latest trip, else the first
  // free window in the month; {start: "", end: ""} when the month has no free day.
  function defaultTripDates(year, month, trips) {
    var last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    var dated = trips.filter(function (t) { return daysBetween(t.start, t.end) !== null; });
    var after = 1;
    dated.forEach(function (t) { var d = +t.end.slice(8, 10) + (trips.length >= 3 ? 1 : 2); if (t.end.slice(0, 7) === year + "-" + pad2(month) && d > after) after = d; });
    var isFree = function (s, e) { return dated.every(function (t) { return e < t.start || s > t.end; }); };
    var order = [];
    for (var d = after; d <= last; d++) order.push(d);
    for (d = 1; d < after; d++) order.push(d);
    var lens = trips.length >= 3 ? [1] : [4, 2, 1]; // later trips are shorter so up to 10 fit in a month
    for (var pass = 0; pass < 2; pass++) {
      for (var li = 0; li < lens.length; li++) {
        for (var oi = 0; oi < order.length; oi++) {
          var day = order[oi], endDay = day + lens[li];
          if (endDay > last) continue;
          var wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
          if (pass === 0 && trips.length < 3 && (wd === 0 || wd === 6)) continue; // weekdays first (until space gets tight)
          var st = year + "-" + pad2(month) + "-" + pad2(day), en = year + "-" + pad2(month) + "-" + pad2(endDay);
          if (isFree(st, en)) return { start: st, end: en };
        }
      }
    }
    return { start: "", end: "" };
  }
  // Totals of the edited km: {kmHalf, km, cents} (cents = sum of the per-row rounded values) or null.
  function tripsTotals(trips, rateCents) {
    var half = 0, cents = 0;
    for (var i = 0; i < trips.length; i++) {
      var h = kmHalfUnits(trips[i].km), c = tripValueCents(trips[i].km, rateCents);
      if (h === null || c === null) return null;
      half += h; cents += c;
    }
    return { kmHalf: half, km: half % 2 ? Math.floor(half / 2) + ".5" : String(half / 2), cents: cents };
  }

  // Mirrors perdiem/profile.py validate_profile (English messages; kind "expenses" checks only the name).
  function len(s) { return Array.from(s).length; }
  function fieldErrors(label, v, lo, hi) {
    var n = len(v);
    if (n < lo || n > hi) return [label + " must have " + (lo ? lo + " to " + hi : "at most " + hi) + " characters."];
    if (CONTROL.test(v) || v !== v.trim()) {
      return [label + " must not contain control or invisible characters, or spaces at the ends."];
    }
    if (!Array.from(v).every(function (c) { return /^[\p{L}\p{N}]$/u.test(c) || " -'’.".indexOf(c) >= 0; })) {
      return [label + " may only contain letters, digits, spaces, hyphens, apostrophes and periods."];
    }
    return [];
  }
  function profileIssues(p, kind) {
    p = p || {};
    var name = typeof p.name === "string" ? p.name : "";
    var errors = fieldErrors("Name", name, 2, 60);
    if (!errors.length) {
      var letters = name.normalize("NFKD").replace(/[^A-Za-z]/g, "");
      if (letters.length < 2) errors.push("Name needs at least 2 letters A-Z (accents are removed).");
    }
    if (kind !== "expenses") {
      errors = errors.concat(fieldErrors("Office", typeof p.office === "string" ? p.office : "", 1, 30));
      errors = errors.concat(fieldErrors("Plate", typeof p.plate === "string" ? p.plate : "", 0, 15));
    }
    return errors;
  }

  // ---- Expenses Report (entries: {date, description, projectOn, project, amount} and
  //      {date, value, proofId}; amounts are the typed strings, money is integer cents) ----
  var EXPENSE_MAX_CENTS = 9999999; // 99999.99
  var EXPENSE_LIMITS = { description: 60, project: 20, rows: 20 };
  var MAX_PROOF_BYTES = 8 * 1024 * 1024;
  var MAX_TOTAL_PROOF_BYTES = 25 * 1000 * 1000; // same as the server (assemble.MAX_TOTAL_PROOF_BYTES)

  // Real calendar date in plain YYYY-MM-DD (any year); week/ordinal forms are not accepted.
  function isoDateOk(s) {
    var m = typeof s === "string" ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s) : null;
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(2000, mo - 1, d));
    dt.setUTCFullYear(y);
    return mo >= 1 && mo <= 12 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  function plainText(s, max, required) {
    return (!required || s !== "") && len(s) <= max && !CONTROL.test(s);
  }
  function expenseIssues(e) {
    e = e || {};
    var out = [], desc = clean(e.description), proj = clean(e.project);
    if (!isoDateOk(e.date)) out.push("Enter a valid date.");
    if (!plainText(desc, EXPENSE_LIMITS.description, true)) {
      out.push("Description: 1 to " + EXPENSE_LIMITS.description + " characters, no special spaces.");
    }
    if (e.projectOn && !plainText(proj, EXPENSE_LIMITS.project, true)) {
      out.push("Project: 1 to " + EXPENSE_LIMITS.project + " characters, no special spaces.");
    }
    if (parseAmount(e.amount, EXPENSE_MAX_CENTS) === null) {
      out.push("Amount must be greater than 0 and at most 99999.99, with at most 2 decimals.");
    }
    return out;
  }
  function invoiceIssues(v) {
    v = v || {};
    var out = [];
    if (!isoDateOk(v.date)) out.push("Enter a valid date.");
    if (parseAmount(v.value, EXPENSE_MAX_CENTS) === null) {
      out.push("Value must be greater than 0 and at most 99999.99, with at most 2 decimals.");
    }
    if (typeof v.proofId !== "string" || v.proofId === "") out.push("Attach the proof file.");
    return out;
  }
  function isExpenseEntryComplete(e) { return !!e && typeof e === "object" && expenseIssues(e).length === 0; }
  function isInvoiceEntryComplete(v) { return !!v && typeof v === "object" && invoiceIssues(v).length === 0; }
  function sumCents(list) {
    return (list || []).reduce(function (a, c) { return a + c; }, 0);
  }
  function expensesCountIssue(nExpenses, nInvoices) {
    if (nExpenses > EXPENSE_LIMITS.rows) return "At most " + EXPENSE_LIMITS.rows + " expenses are allowed.";
    if (nInvoices > EXPENSE_LIMITS.rows) return "At most " + EXPENSE_LIMITS.rows + " invoices are allowed.";
    return null;
  }
  function moneyOut(str) {
    var c = parseAmount(str, EXPENSE_MAX_CENTS);
    return c === null ? clean(str) : centsToApi(c); // unparseable stays raw: the server refuses it
  }
  // The body of POST /api/expenses/preview|save: no item numbers, no file names (the server owns them).
  function toExpensesPayload(state) {
    return {
      year: state.year,
      month: state.month,
      expenses: (state.expenses || []).map(function (e) {
        return { date: e.date, description: clean(e.description),
                 project: e.projectOn ? clean(e.project) : "", amount: moneyOut(e.amount) };
      }),
      invoices: (state.invoices || []).map(function (v) {
        return { date: v.date, value: moneyOut(v.value), proof_id: v.proofId };
      })
    };
  }
  // Result of choosing a proof file: the entry keeps its previous proof when the new file fails.
  // outcome: {issue} (budget), {error} (upload failed) or {info} (the server's proof record).
  function proofAttachResult(prev, outcome) {
    if (outcome.info) {
      if (typeof outcome.info.id !== "string" || !outcome.info.id) {
        return { proof: prev, error: "The upload did not return a proof." };
      }
      return { proof: outcome.info, error: "" };
    }
    return { proof: prev, error: outcome.issue || outcome.error || "" };
  }
  // True while the entry row holds something the user has not added with the check mark.
  function expenseRowPending(e) { return !!(clean(e.description) || clean(e.amount)); }
  function invoiceRowPending(v) { return !!(clean(v.value) || v.proofId); }
  // sizesBytes: sizes already attached; newSize: the file being added. Mirrors proofs.py / assemble.py.
  function proofBudgetIssue(sizesBytes, newSize) {
    if (typeof newSize !== "number" || !(newSize >= 0)) return "The file size is not valid.";
    if (newSize > MAX_PROOF_BYTES) return "The file is larger than 8 MB.";
    if (sumCents(sizesBytes) + newSize > MAX_TOTAL_PROOF_BYTES) return "Proofs exceed 25 MB in total.";
    return null;
  }

  // ---- signature image upload (pure pixel / size helpers) ----
  var MAX_SIG_BYTES = 2 * 1024 * 1024;
  var SIG_TYPES = ["image/png", "image/jpeg", "image/webp"];
  // Adaptive background removal for photos/scans: the paper level bg is the 85th-percentile luminance (integer
  // histogram, at least 150); a pixel d = bg - L darker than that is ink: d <= 14 -> transparent, else
  // alpha = min(255, round((d-14)*255/70)) with the pixel's own RGB; input alpha scales the result. Returns a new array.
  function inkToAlpha(rgba) {
    var out = new Uint8ClampedArray(rgba), hist = [], i, total = 0;
    for (i = 0; i < 256; i++) hist.push(0);
    var lum = new Uint8Array(out.length / 4 | 0);
    for (i = 0; i + 3 < out.length; i += 4) {
      var l = Math.floor((299 * out[i] + 587 * out[i + 1] + 114 * out[i + 2]) / 1000);
      lum[i >> 2] = l;
      if (out[i + 3] > 0) { hist[l]++; total++; }
    }
    var bg = 255, cum = 0;
    for (i = 0; i < 256; i++) { cum += hist[i]; if (cum * 100 >= 85 * total) { bg = i; break; } }
    if (bg < 150) bg = 150;
    for (i = 0; i + 3 < out.length; i += 4) {
      var d = bg - lum[i >> 2];
      if (out[i + 3] === 0) continue;
      if (d <= 14) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; }
      else out[i + 3] = Math.round(out[i + 3] * Math.min(255, Math.round((d - 14) * 255 / 70)) / 255);
    }
    return out;
  }
  function countOpaque(rgba) {
    var n = 0;
    for (var i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) n++;
    return n;
  }
  // Largest size within maxW x maxH with the same aspect ratio; never upscales; integers, at least 1x1.
  function fitSize(w, h, maxW, maxH) {
    var k = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  function signatureFileIssue(f) {
    if (f.size > MAX_SIG_BYTES) return "The image is larger than 2 MB.";
    if (SIG_TYPES.indexOf(f.type) < 0) return "Use a PNG, JPG or WebP image.";
    return null;
  }

  var api = {
    inkToAlpha: inkToAlpha, countOpaque: countOpaque, fitSize: fitSize, signatureFileIssue: signatureFileIssue,
    profileIssues: profileIssues,
    isoDateOk: isoDateOk, expenseIssues: expenseIssues, invoiceIssues: invoiceIssues,
    isExpenseEntryComplete: isExpenseEntryComplete, isInvoiceEntryComplete: isInvoiceEntryComplete,
    proofAttachResult: proofAttachResult, expenseRowPending: expenseRowPending,
    invoiceRowPending: invoiceRowPending, sumCents: sumCents, toExpensesPayload: toExpensesPayload, proofBudgetIssue: proofBudgetIssue,
    expensesCountIssue: expensesCountIssue,
    parseAmount: parseAmount, formatCents: formatCents, centsToApi: centsToApi,
    projectIssue: projectIssue, hasProjectGap: hasProjectGap, toPayload: toPayload,
    parseKm: parseKm, kmDisplay: kmDisplay, daysBetween: daysBetween, overlapPairs: overlapPairs,
    msgOverlap: msgOverlap, dateIssues: dateIssues, defaultTripDates: defaultTripDates, MAX_TRIPS: MAX_TRIPS, rateToCents: rateToCents, tripValueCents: tripValueCents,
    locationOk: locationOk,
    tripIssues: tripIssues, tripsIssues: tripsIssues, tripsTotals: tripsTotals
  };
  root.PerDiemLogic = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
