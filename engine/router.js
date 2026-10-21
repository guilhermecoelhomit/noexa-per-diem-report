// In-memory "server" of the web edition: the same routes, status codes and error shapes as
// perdiem/server.py, for the Per Diem and Expenses flows. router.create({config, now, pdf, proofs,
// logoUri}) -> {handle(method, path, body, asText) -> Promise<{ok, status, data}>}.
//  - pdf: {perDiem(profile, trips, year, month, signatureBase64) -> Promise<Uint8Array>,
//    expenses(profile, expenses, invoices, year, month, signatureBase64, proofPages) -> Promise<Uint8Array>}
//    (injectable for tests; they default to pdf_perdiem.js / pdf_expenses.js, loaded only when a PDF is made).
//  - proofs: the proof store (default: a new proofs.createStore(), in memory): get(proof_id) ->
//    {name, kind, pages, size} | null, and for the PDF image(proof_id) -> images.prepare's result
//    (image proofs) and pdf(proof_id) -> Uint8Array (PDF proofs);
//    add({name, bytes}) serves POST /api/expenses/proof (body {name, bytes: Uint8Array}, answered
//    like the local server: 200 {id, name, kind, size, pages}, 413 / 422 {error: "..."}).
//    Invoice numbers and the proof name/kind/pages always come from here, never from the client.
//  - /api/expenses/save: the report pages, then the proof pages in invoice order (proofPages, each
//    {title: "Proof for invoice N · name", image} for an image, or {title: "Proof for invoice N ·
//    attached PDF (k pages)", note: name, proofPdf: bytes, pages: k} for a PDF: its separator page,
//    then its own k pages); the 25 000 000-byte total of the proofs is checked first, as
//    assemble._check_total (422 ["Proofs exceed 25 MB in total."]). A proof PDF that cannot be
//    merged gives 422 [MergeError text], as the local server.
//  - Profile and signature live only in this router instance (nothing is stored anywhere).
//  - Parsing is as strict as the Python server (400 for malformed input, 422 for rule violations);
//    the validators in validate.js only ever see well-formed trips.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./money.js"), require("./dates.js"), require("./validate.js"),
      require("./filenames.js"), require("./preview.js"), require("./signature.js"), require("./config.js"),
      function () { return require("./pdf_perdiem.js"); }, function () { return require("./pdf_expenses.js"); },
      require("./proofs.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.router = factory(ns.money, ns.dates, ns.validate, ns.filenames, ns.preview, ns.signature, ns.config,
      function () { return ns.pdfPerDiem; }, function () { return ns.pdfExpenses; }, ns.proofs);
  }
})(typeof self !== "undefined" ? self : this, function (money, dates, validate, filenames, preview, signature, engineConfig,
  loadPdfPerDiem, loadPdfExpenses, proofsModule) {
  "use strict";
  var MAX_TRIPS = 10, MAX_KM = money.parse("9999.5");
  var ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  var NAME_MIN = 2, NAME_MAX = 60, OFFICE_MIN = 1, OFFICE_MAX = 30, PLATE_MAX = 15;
  var ALLOWED_PUNCT = " -'’.";
  var REPORT_KINDS = ["perdiem", "expenses"];

  function ApiError(status, error, extra) {
    this.status = status; this.error = error; this.extra = extra || {};
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function isInt(v) { return typeof v === "number" && Number.isInteger(v); }
  // A present field; `undefined` counts as absent (JSON never carries it).
  function has(o, k) { return hasOwn(o, k) && o[k] !== undefined; }
  function get(o, k, dflt) { return has(o, k) ? o[k] : dflt; }
  function field(body, key) {
    if (!has(body, key)) throw new ApiError(400, "Missing field: " + key);
    return body[key];
  }

  function yearMonth(body) {
    var year = field(body, "year"), month = field(body, "month");
    if (!isInt(year) || !isInt(month) || year < 2000 || year > 2100 || month < 1 || month > 12) {
      throw new ApiError(400, "Year or month outside the allowed range.");
    }
    return [year, month];
  }

  // Trim whitespace at both ends like server._strip (Python isspace or category Zs).
  function isBlank(c) {
    var cp = c.codePointAt(0);
    return (cp >= 9 && cp <= 13) || (cp >= 0x1c && cp <= 0x1f) || cp === 0x85 || cp === 0x2028 || cp === 0x2029 ||
      /^\p{Zs}$/u.test(c);
  }
  function strip(s) {
    var chars = Array.from(s), i = 0, j = chars.length;
    while (i < j && isBlank(chars[i])) i++;
    while (j > i && isBlank(chars[j - 1])) j--;
    return chars.slice(i, j).join("");
  }

  function isoDate(v, bad) { // "YYYY-MM-DD" naming a real day -> {y, m, d}
    var d = typeof v === "string" && ISO_DATE.test(v) ? dates.parseIso(v) : null;
    if (d === null) throw bad;
    return d;
  }

  // Decimal's adjusted(): exponent of the most significant digit (the server answers 400 beyond +-9).
  function adjusted(d) {
    var n = d.n < 0n ? -d.n : d.n;
    return String(n).length - 1 - d.s;
  }

  function tripDays(t, start, bad) {
    var days = null, endDays = null;
    if (has(t, "days")) {
      days = t.days;
      if (!isInt(days)) throw bad;
    }
    if (has(t, "end")) endDays = dates.daysBetween(start, isoDate(t.end, bad));
    if (days === null && endDays === null) throw bad;
    if (days !== null && endDays !== null && days !== endDays) {
      throw new ApiError(400, "The trip end date does not match its start date and days.");
    }
    if (endDays === null && !(days >= 1 && days <= 31)) throw bad; // legacy start + days callers
    var value = endDays !== null ? endDays : days;
    if (Math.abs(value) > 400) throw bad;
    return value;
  }

  // km is a string or an integer, never a float or boolean (like the server).
  function kmText(km) {
    if (typeof km === "string") return km;
    if (isInt(km)) return String(km);
    return null;
  }

  function parseTrips(body) {
    var raw = field(body, "trips");
    if (!Array.isArray(raw) || !raw.length) throw new ApiError(400, "Invalid trip list.");
    if (raw.length > MAX_TRIPS) {
      throw new ApiError(422, ["Between 1 and " + MAX_TRIPS + " trips are required (received " + raw.length + ")."]);
    }
    var bad = new ApiError(400, "Trip with missing or invalid fields.");
    return raw.map(function (t, i) {
      if (!isObject(t)) throw bad;
      var km = t.km, start = t.start, location = t.location;
      if (!has(t, "km") || !has(t, "start") || !has(t, "location")) throw bad;
      var project = get(t, "project", "");
      if (typeof project !== "string") throw bad;
      var kt = kmText(km);
      if (typeof location !== "string" || kt === null) throw bad;
      var startD = isoDate(start, bad);
      var days = tripDays(t, startD, bad);
      location = strip(location); project = strip(project);
      if (!location) throw bad;
      var d = money.parse(kt);
      if (d === null || Math.abs(adjusted(d)) > 9) throw bad;
      return { number: i + 1, start: start, days: days, location: location, km: kt, project: project };
    });
  }

  // Draft preview only: whatever parses is shown, the rest is left blank; wrong types are still 400.
  function lenientTrips(body) {
    var raw = field(body, "trips");
    if (!Array.isArray(raw)) throw new ApiError(400, "Invalid trip list.");
    if (raw.length > MAX_TRIPS) {
      throw new ApiError(422, ["Between 1 and " + MAX_TRIPS + " trips are required (received " + raw.length + ")."]);
    }
    var bad = new ApiError(400, "Trip with missing or invalid fields.");
    function text(t, key) {
      var v = get(t, key, "");
      if (typeof v !== "string") throw bad;
      return strip(v);
    }
    function day(t, key) {
      var v = get(t, key, "");
      if (typeof v !== "string") throw bad;
      return ISO_DATE.test(v) && dates.parseIso(v) ? v : null;
    }
    return raw.map(function (t, i) {
      if (!isObject(t)) throw bad;
      var kt = kmText(get(t, "km", ""));
      if (kt === null) throw bad;
      var d = money.parse(kt);
      var km = d !== null && money.compare(d, { n: 0n, s: 0 }) > 0 && money.compare(d, MAX_KM) <= 0 ? kt : null;
      var start = day(t, "start"), end = day(t, "end");
      var days = start && end && dates.daysBetween(dates.parseIso(start), dates.parseIso(end)) > 0
        ? dates.daysBetween(dates.parseIso(start), dates.parseIso(end)) : null;
      return { number: i + 1, start: start, days: days, location: text(t, "location"), km: km,
               project: text(t, "project"), endHint: end };
    });
  }

  // ---- Expenses Report (server._list_field, _money, _parse_expenses, _parse_invoices) ----
  var MAX_EXPENSE_ROWS = 20;
  var PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
  var PROOF_ID = /^[0-9a-f]{32}$/;

  function listField(body, key) {
    var raw = field(body, key);
    if (!Array.isArray(raw)) throw new ApiError(400, "Invalid " + key + " list.");
    return raw;
  }

  // Amounts arrive as strings (or integers), never floats/booleans; range and decimals are 422 rules.
  function moneyText(v, bad) {
    var s = typeof v === "string" ? v : isInt(v) ? String(v) : null;
    if (s === null || !PLAIN_NUMBER.test(s)) throw bad;
    var d = money.parse(s);
    if (d === null || Math.abs(adjusted(d)) > 9) throw bad;
    return s;
  }

  function parseExpenses(raw) {
    var bad = new ApiError(400, "Expense with missing or invalid fields.");
    return raw.map(function (e, i) {
      if (!isObject(e) || !has(e, "description") || !has(e, "date") || !has(e, "amount")) throw bad;
      var description = e.description, project = get(e, "project", "");
      if (typeof description !== "string" || typeof project !== "string") throw bad;
      isoDate(e.date, bad);
      var amount = moneyText(e.amount, bad);
      return { number: i + 1, date: e.date, description: strip(description), project: strip(project), amount: amount };
    });
  }

  // proof_name/kind/pages ALWAYS come from the proof store; the client's are ignored.
  function parseInvoices(raw, store) {
    var bad = new ApiError(400, "Invoice with missing or invalid fields.");
    return raw.map(function (inv, i) {
      if (!isObject(inv) || !has(inv, "proof_id") || !has(inv, "date") || !has(inv, "value")) throw bad;
      var pid = inv.proof_id;
      if (typeof pid !== "string") throw bad;
      isoDate(inv.date, bad);
      var value = moneyText(inv.value, bad);
      var info = null;
      try { info = PROOF_ID.test(pid) ? store.get(pid) : null; } catch (e) { info = null; }
      if (!isObject(info)) {
        throw new ApiError(422, ["Invoice " + (i + 1) + ": the proof file is missing or expired; attach it again."]);
      }
      return { number: i + 1, date: inv.date, value: value, proof_id: pid,
               proof_name: info.name, proof_kind: info.kind, proof_pages: info.pages };
    });
  }

  // ---- profile (perdiem/profile.py) ----
  function len(s) { return Array.from(s).length; }
  function charsOk(s) {
    return Array.from(s).every(function (c) { return /^[\p{L}\p{N}]$/u.test(c) || ALLOWED_PUNCT.indexOf(c) >= 0; });
  }
  function fieldErrors(label, value, lo, hi) {
    var n = len(value);
    if (n < lo || n > hi) return [label + " must have " + (lo ? lo + " to " + hi : "at most " + hi) + " characters."];
    if (validate.badText(value)) {
      return [label + " must not contain control or invisible characters, or spaces at the ends."];
    }
    if (!charsOk(value)) {
      return [label + " may only contain letters, digits, spaces, hyphens, apostrophes and periods."];
    }
    return [];
  }
  function validateProfile(p, kind) {
    var errors = fieldErrors("Name", p.name, NAME_MIN, NAME_MAX);
    if (!errors.length && filenames.stem(p.name) === null) {
      errors.push("Name needs at least 2 letters A-Z (accents are removed).");
    }
    if (kind !== "expenses") {
      errors = errors.concat(fieldErrors("Office", p.office, OFFICE_MIN, OFFICE_MAX), fieldErrors("Plate", p.plate, 0, PLATE_MAX));
    }
    return errors;
  }

  // ---- base64 ----
  var B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  function fromBase64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return btoa(parts.join(""));
  }

  function create(deps) {
    deps = deps || {};
    var cfg = Object.assign({}, engineConfig, deps.config);
    var pdf = deps.pdf || {};
    var perDiemPdf = pdf.perDiem || function (profile, trips, year, month, sigB64) {
      var builder = loadPdfPerDiem();
      if (!builder) throw new Error("pdf_perdiem.js is not loaded.");
      return builder.build(profile, trips, year, month, sigB64, { config: cfg });
    };
    var expensesPdf = pdf.expenses || function (profile, expenses, invoices, year, month, sigB64, proofPages) {
      var builder = loadPdfExpenses();
      if (!builder) throw new Error("pdf_expenses.js is not loaded.");
      return builder.build(profile, expenses, invoices, year, month, sigB64, proofPages, { config: cfg });
    };
    var proofStore = deps.proofs || proofsModule.createStore();
    var logoUri = deps.logoUri;
    var now = deps.now || function () { return new Date(); };
    void now;
    var stored = null;         // {name, office?, plate?} or null: the profile of this session
    var signatureB64 = null;   // canonical base64 of the validated PNG, or null

    // (profile, nameSaved, complete) as perdiem.profile.load_profile_state with empty defaults.
    function profileState() {
      var dflt = { name: "", office: "", plate: "" };
      if (stored === null || validateProfile({ name: stored.name, office: "x", plate: "" }, "expenses").length) {
        return { p: dflt, nameSaved: false, complete: false };
      }
      if (typeof stored.office === "string" && typeof stored.plate === "string") {
        var full = { name: stored.name, office: stored.office, plate: stored.plate };
        if (!validateProfile(full, "perdiem").length) return { p: full, nameSaved: true, complete: true };
      }
      return { p: { name: stored.name, office: dflt.office, plate: dflt.plate }, nameSaved: true, complete: false };
    }
    function profileJson(st) {
      return { name: st.p.name, office: st.p.office, plate: st.p.plate, saved: st.nameSaved, complete: st.complete };
    }

    function getProfile() { return { status: 200, data: profileJson(profileState()) }; }

    function setProfile(body) {
      var kind = get(body, "kind", "perdiem");
      if (REPORT_KINDS.indexOf(kind) < 0) throw new ApiError(400, "Invalid kind (perdiem or expenses).");
      var keys = kind === "expenses" ? ["name"] : ["name", "office", "plate"], vals = [];
      keys.forEach(function (key) {
        if (!has(body, key)) throw new ApiError(400, "Missing field: " + key);
        if (typeof body[key] !== "string") throw new ApiError(400, "Field must be a string: " + key);
        vals.push(body[key]);
      });
      var p = kind === "expenses" ? { name: vals[0], office: "", plate: "" } : { name: vals[0], office: vals[1], plate: vals[2] };
      var errors = validateProfile(p, kind);
      if (errors.length) throw new ApiError(422, errors);
      if (kind === "expenses") { // only the name is stored; an already confirmed office/plate is kept
        var next = { name: p.name };
        if (stored && typeof stored.office === "string" && typeof stored.plate === "string") {
          next.office = stored.office; next.plate = stored.plate;
        }
        stored = next;
      } else {
        stored = { name: p.name, office: p.office, plate: p.plate };
      }
      var st = profileState();
      st.nameSaved = true;
      return { status: 200, data: profileJson(st) };
    }

    async function setSignature(body) {
      var raw = field(body, "png_base64");
      if (typeof raw !== "string") throw new ApiError(400, "Invalid png_base64.");
      if (raw.indexOf("data:") === 0) {
        var comma = raw.indexOf(",");
        var head = comma < 0 ? raw : raw.slice(0, comma);
        raw = comma < 0 ? "" : raw.slice(comma + 1);
        if (head.indexOf("data:image/png;base64") !== 0) throw new ApiError(422, "The signature must be a PNG.");
      }
      if (!B64.test(raw)) throw new ApiError(422, "Invalid signature (base64).");
      var png = fromBase64(raw);
      try {
        await signature.validate(png);
      } catch (e) {
        throw new ApiError(422, e.message);
      }
      signatureB64 = toBase64(png);
      return { status: 200, data: { signed: true } };
    }

    function parseAndValidate(body) {
      var ym = yearMonth(body), year = ym[0], month = ym[1];
      var trips = parseTrips(body);
      var errors = validate.trips(trips, year, month);
      if (errors.length) throw new ApiError(422, errors);
      return { year: year, month: month, trips: trips };
    }

    function previewHtml(profile, trips, year, month, draft) {
      return preview.perDiemHtml(profile, trips, year, month, signatureB64, { draft: draft, config: cfg, logoUri: logoUri });
    }

    function previewRoute(body) {
      if (body.draft === true) { // lenient draft: shows what is filled in, nothing is validated or saved
        var ym = yearMonth(body);
        return { status: 200, data: previewHtml(profileState().p, lenientTrips(body), ym[0], ym[1], true) };
      }
      var r = parseAndValidate(body);
      return { status: 200, data: previewHtml(profileState().p, r.trips, r.year, r.month, false) };
    }

    async function saveRoute(body) {
      if (signatureB64 === null) {
        yearMonth(body);
        throw new ApiError(422, "Signature missing: sign before saving.");
      }
      var st = profileState();
      if (st.nameSaved && !st.complete) { // an Expenses-only profile
        throw new ApiError(422, "Confirm your Office and Plate in the Profile before generating the Per Diem Report.");
      }
      var r = parseAndValidate(body);
      var profileErrors = validateProfile(st.p, "perdiem");
      if (profileErrors.length) throw new ApiError(422, profileErrors);
      var bytes = await perDiemPdf(st.p, r.trips, r.year, r.month, signatureB64);
      return { status: 200, data: { pdf_base64: toBase64(bytes),
        filename: filenames.pdfName(filenames.stem(st.p.name), "perdiem", r.year, r.month) } };
    }

    // server.Handler._render_expenses: the preview shows the empty template; saving needs an entry.
    function renderExpenses(body, signed) {
      var ym = yearMonth(body);
      if (signed && signatureB64 === null) throw new ApiError(422, "Signature missing: sign before saving.");
      var rawEx = listField(body, "expenses"), rawIv = listField(body, "invoices");
      if (rawIv.length > MAX_EXPENSE_ROWS) {
        throw new ApiError(422, ["At most " + MAX_EXPENSE_ROWS + " invoices are allowed (received " + rawIv.length + ")."]);
      }
      var expenses = parseExpenses(rawEx), invoices = parseInvoices(rawIv, proofStore);
      var errors = validate.expenseReport(expenses, invoices);
      if (!signed) errors = errors.filter(function (e) { return e.indexOf("Add at least one") !== 0; });
      var profile = profileState().p;
      // The profile is only required to save (Office/Plate are not used here): the web profile starts
      // empty in every session, and the preview must show the empty template from the start.
      if (signed) errors = errors.concat(validateProfile(profile, "expenses"));
      if (errors.length) throw new ApiError(422, errors);
      return { year: ym[0], month: ym[1], expenses: expenses, invoices: invoices, profile: profile };
    }

    function expensesPreviewRoute(body) {
      var r = renderExpenses(body, false);
      var n = 0;
      r.invoices.forEach(function (i) { n += 1 + (i.proof_kind === "pdf" ? i.proof_pages : 0); });
      var note = n ? '<p class="proof-note" style="margin:8px 0;color:#657D7F;font-size:10pt">' + n +
        " proof page(s) will be added</p>" : "";
      return { status: 200, data: preview.expensesHtml(r.profile, r.expenses, r.invoices, r.year, r.month, signatureB64,
        { config: cfg, logoUri: logoUri, proofPagesHtml: note }) };
    }

    // assemble._check_total, then the proof pages in invoice order (a proof whose image is gone,
    // e.g. a store that only has metadata, fails closed like an expired file).
    function proofPagesFor(invoices) {
      var total = 0;
      invoices.forEach(function (inv) {
        var info = proofStore.get(inv.proof_id);
        if (!isObject(info)) throw new ApiError(422, [proofsModule.MSG_EXPIRED]);
        total += Number(info.size) || 0;
      });
      if (total > proofsModule.MAX_TOTAL_PROOF_BYTES) throw new ApiError(422, [proofsModule.MSG_TOTAL]);
      return invoices.map(function (inv) {
        var head = "Proof for invoice " + inv.number, name = preview.proofDisplayName(inv.proof_name);
        if (inv.proof_kind === "pdf") {
          var bytes = typeof proofStore.pdf === "function" ? proofStore.pdf(inv.proof_id) : null;
          if (Object.prototype.toString.call(bytes) !== "[object Uint8Array]") throw new ApiError(422, [proofsModule.MSG_EXPIRED]);
          var k = inv.proof_pages;
          return { title: head + " · attached PDF (" + k + " page" + (k === 1 ? "" : "s") + ")", note: name,
                   proofPdf: bytes, pages: k };
        }
        var image = typeof proofStore.image === "function" ? proofStore.image(inv.proof_id) : null;
        if (!isObject(image)) throw new ApiError(422, [proofsModule.MSG_EXPIRED]);
        return { title: head + " · " + name, image: image };
      });
    }

    async function expensesSaveRoute(body) {
      var r = renderExpenses(body, true);
      var proofPages = proofPagesFor(r.invoices), bytes;
      try {
        bytes = await expensesPdf(r.profile, r.expenses, r.invoices, r.year, r.month, signatureB64, proofPages);
      } catch (e) {
        if (e && e.name === "MergeError") throw new ApiError(422, [e.message]); // unusable proof PDF
        throw e;
      }
      return { status: 200, data: { pdf_base64: toBase64(bytes),
        filename: filenames.pdfName(filenames.stem(r.profile.name), "expenses", r.year, r.month) } };
    }

    async function proofRoute(body) {
      if (typeof proofStore.add !== "function") throw new ApiError(404, "Unknown route.");
      if (Object.prototype.toString.call(body.bytes) !== "[object Uint8Array]") throw new ApiError(400, "Incomplete upload.");
      try {
        var info = await proofStore.add({ name: typeof body.name === "string" ? body.name : "", bytes: body.bytes });
        return { status: 200, data: { id: info.id, name: info.name, kind: info.kind, size: info.size, pages: info.pages } };
      } catch (e) {
        if (e instanceof proofsModule.ProofError) throw new ApiError(e.status, e.message);
        throw e;
      }
    }

    var ROUTES = {
      GET: {
        "/api/settings": function () { return { status: 200, data: { rate: String(cfg.unit_rate) } }; },
        "/api/signature": function () { return { status: 200, data: { signed: signatureB64 !== null } }; },
        "/api/profile": getProfile
      },
      POST: {
        "/api/preview": previewRoute,
        "/api/save": saveRoute,
        "/api/expenses/preview": expensesPreviewRoute,
        "/api/expenses/save": expensesSaveRoute,
        "/api/expenses/proof": proofRoute,
        "/api/signature": setSignature,
        "/api/profile": setProfile
      }
    };

    async function handle(method, path, body) {
      try {
        var table = hasOwn(ROUTES, method) ? ROUTES[method] : null;
        var fn = table && hasOwn(table, path) ? table[path] : null;
        if (fn === null) {
          var known = Object.keys(ROUTES).some(function (m) { return hasOwn(ROUTES[m], path); });
          if (known || table === null) throw new ApiError(405, "Method not allowed.");
          throw new ApiError(404, "Unknown route.");
        }
        if (method === "POST" && !isObject(body)) throw new ApiError(400, "The body must be a JSON object.");
        var res = await fn(method === "POST" ? body : {});
        return { ok: true, status: res.status, data: res.data };
      } catch (e) {
        if (e instanceof ApiError) {
          var data = { error: e.error };
          for (var k in e.extra) data[k] = e.extra[k];
          return { ok: false, status: e.status, data: data };
        }
        // No server log exists in the web edition: the browser console is the only trace to ask for.
        if (typeof console !== "undefined" && console.error) console.error("[PerDiemEngine]", method, path, e);
        return { ok: false, status: 500, data: { error: "Something went wrong while building the PDF. Reload the page and try again." } };
      }
    }

    return { handle: handle };
  }

  return { create: create };
});
