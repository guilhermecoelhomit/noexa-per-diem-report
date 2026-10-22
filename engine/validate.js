// Validation identical to perdiem/validator.py (same rules, same English messages).
// Trip: {number, start: "YYYY-MM-DD", days, location, km: decimal string, project}.
// Expense: {number, date, location, description, project, amount, proofs: [{id, name, kind, pages,
// size}]}: any number of expenses, any number of proofs per expense, each proof id once in the
// report. Values are already trimmed by the caller.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./money.js"), require("./dates.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.validate = factory(ns.money, ns.dates);
  }
})(typeof self !== "undefined" ? self : this, function (money, dates) {
  "use strict";
  var MAX_PROJECT = 20, MAX_LOCATION = 30, MAX_TRIPS = 10;
  var MAX_DESCRIPTION = 60, MAX_PROOF_NAME = 255;
  var ZERO = { n: 0n, s: 0 };
  var MAX_KM = money.parse("9999.5"), MAX_AMOUNT = money.parse("99999.99");
  var CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
  var PROOF_ID = /^[0-9a-f]{32}$/;
  var ENDS = "characters, with no control or invisible characters and no leading or trailing spaces.";

  function len(s) { return Array.from(s).length; } // code points, like Python len()
  function badText(s) { return CONTROL.test(s) || s !== s.trim(); }
  function projectError(p) { return len(p) > MAX_PROJECT || badText(p); }
  function locationError(l) { return !l || len(l) > MAX_LOCATION || badText(l); }
  function scale(s) { return BigInt("1" + "0".repeat(s)); }

  function trips(list, year, month) {
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TRIPS) {
      return ["Between 1 and " + MAX_TRIPS + " trips are required (received " + (list ? list.length : 0) + ")."];
    }
    var errors = [];
    if (!list.every(function (t, i) { return t.number === i + 1; })) {
      errors.push("Trips must be numbered 1, 2, 3... in order.");
    }
    list.forEach(function (t) {
      if (projectError(t.project)) {
        errors.push("Trip " + t.number + ": the project must have at most " + MAX_PROJECT + " " + ENDS);
      }
    });
    list.forEach(function (t) {
      if (locationError(t.location)) {
        errors.push("Trip " + t.number + ": the location must have 1 to " + MAX_LOCATION + " " + ENDS);
      }
    });
    list.forEach(function (t) {
      if (!(t.days > 0)) errors.push("Trip " + t.number + ": the end date must be after the start date.");
    });

    var dated = [];
    list.forEach(function (t) {
      var s = dates.parseIso(t.start);
      if (t.days > 0 && s) dated.push({ number: t.number, start: s, end: dates.addDays(s, t.days) });
    });
    var outside = dated.some(function (t) {
      return [t.start, t.end].some(function (d) { return d.y !== year || d.m !== month; });
    });
    if (outside) {
      errors.push("The start and end dates of the trips must fall within the month " +
        (month < 10 ? "0" : "") + month + "/" + year + ".");
    }
    for (var i = 0; i < dated.length; i++) {
      for (var j = i + 1; j < dated.length; j++) {
        var a = dated[i], b = dated[j];
        if (dates.dayNumber(a.start) <= dates.dayNumber(b.end) && dates.dayNumber(b.start) <= dates.dayNumber(a.end)) {
          errors.push("Trips " + a.number + " and " + b.number +
            " overlap or share a date (trips must not overlap or coincide).");
        }
      }
    }

    list.forEach(function (t) {
      var km = money.parse(t.km);
      if (km === null || money.compare(km, ZERO) <= 0 || money.compare(km, MAX_KM) > 0) {
        errors.push("Trip " + t.number + ": km must be greater than 0 and at most 9999.5.");
      } else if ((km.n * 2n) % scale(km.s) !== 0n) {
        errors.push("Trip " + t.number + ": km must be a multiple of 0.5.");
      }
    });
    return errors;
  }

  function amountOk(v) {
    var d = money.parse(v);
    if (d === null || money.compare(d, ZERO) <= 0 || money.compare(d, MAX_AMOUNT) > 0) return false;
    return d.s <= 2 || d.n % scale(d.s - 2) === 0n; // nothing but zeros beyond 2 decimals
  }

  function expenseReport(expenses) {
    var errors = [];
    expenses = expenses || [];
    if (!expenses.length) errors.push("Add at least one expense.");
    if (!expenses.every(function (e, i) { return e.number === i + 1; })) {
      errors.push("Expenses must be numbered 1, 2, 3... in order.");
    }

    var seen = {};
    expenses.forEach(function (e) {
      if (locationError(e.location)) {
        errors.push("Expense " + e.number + ": the location must have 1 to " + MAX_LOCATION + " " + ENDS);
      }
      if (!e.description || len(e.description) > MAX_DESCRIPTION || badText(e.description)) {
        errors.push("Expense " + e.number + ": the description must have 1 to " + MAX_DESCRIPTION + " " + ENDS);
      }
      if (projectError(e.project)) {
        errors.push("Expense " + e.number + ": the project must have at most " + MAX_PROJECT + " " + ENDS);
      }
      if (!amountOk(e.amount)) {
        errors.push("Expense " + e.number + ": the amount must be greater than 0 and at most 99999.99, with at most 2 decimals.");
      }
      (e.proofs || []).forEach(function (pr, k) {
        var tag = "Expense " + e.number + ", proof " + (k + 1);
        if (pr.kind !== "image" && pr.kind !== "pdf") errors.push(tag + ": the proof must be an image or a PDF.");
        if (typeof pr.id !== "string" || !PROOF_ID.test(pr.id)) {
          errors.push(tag + ": the proof reference is invalid.");
        } else if (Object.prototype.hasOwnProperty.call(seen, pr.id)) {
          errors.push(seen[pr.id] !== e.number
            ? tag + ": this proof is already attached to expense " + seen[pr.id] +
              "; a proof can be used only once in the report (it appears more than once)."
            : tag + ": the same proof is attached more than once to this expense.");
        } else {
          seen[pr.id] = e.number;
        }
        if (!pr.name || len(pr.name) > MAX_PROOF_NAME || badText(pr.name)) {
          errors.push(tag + ": the proof name must have 1 to " + MAX_PROOF_NAME + " " + ENDS);
        }
        if (!(pr.pages >= 1)) errors.push(tag + ": the proof must have at least 1 page.");
      });
    });
    return errors;
  }

  return { trips: trips, expenseReport: expenseReport, badText: badText };
});
