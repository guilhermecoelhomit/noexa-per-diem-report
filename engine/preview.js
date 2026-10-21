// Per Diem preview HTML: a port of perdiem/renderer.py::render_report_html and
// perdiem/templates/report.html (same markup and CSS, same fit-scale heuristic, same rounding).
// All money is computed here in integer cents (ROUND_HALF_UP per line); the page sends no totals.
// Trips: {number, start: "YYYY-MM-DD"|null, days: int|null, location, km: decimal string|null,
// project, endHint?: "YYYY-MM-DD"|null}; km/start/days are null only in draft mode (blank cells).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./money.js"), require("./dates.js"), require("./config.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.preview = factory(ns.money, ns.dates, ns.config);
  }
})(typeof self !== "undefined" ? self : this, function (money, dates, defaultConfig) {
  "use strict";
  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"];

  var TEMPLATE = [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Per Diem Report - $month_label</title>",
    "<style>",
    "@page { size: A4; margin: 14mm 12mm 12mm 12mm; }",
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; padding: 0; background: #fff; }",
    "body { color: #000; font: 10.5pt/1.45 Calibri, \"Segoe UI\", Arial, sans-serif; }",
    ".page { width: 100%; min-height: 268mm; display: flex; flex-direction: column; }",
    ".top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #8C2585; padding-bottom: 8px; }",
    ".top img.logo { height: 52px; }",
    ".top .t { text-align: right; }",
    ".top .t b { display: block; font-size: 19pt; color: #8C2585; letter-spacing: .3px; }",
    ".top .t span { color: #657D7F; font-size: 10.5pt; }",
    "table { width: 100%; border-collapse: collapse; }",
    ".info { margin: 14px 0 4px; width: auto; }",
    ".info td { padding: 1px 12px 1px 0; border: none; font-size: 10.5pt; }",
    ".info td:first-child { width: 70px; font-weight: 700; color: #657D7F; }",
    ".tb { margin-top: 12px; }",
    ".tb th, .tb td { white-space: nowrap; }",
    ".tb th { font-size: calc(6pt * var(--k, 1)); text-align: left; padding: 4px 2px; border-top: 1px solid #8C2585; border-bottom: 1px solid #8C2585; color: #8C2585; }",
    ".tb td { padding: 5px 2px; border-bottom: 1px solid #ddd; font-size: calc(7pt * var(--k, 1)); }",
    ".tb .r { text-align: right; }",
    ".tb .tot td { font-weight: 700; border-top: 1px solid #8C2585; border-bottom: 1px solid #8C2585; }",
    ".sum { width: 46%; margin: 14px 0 0 auto; }",
    ".sum td { padding: 2px 0; font-size: 10.5pt; }",
    ".sum .r { text-align: right; }",
    ".sum .g td { font-weight: 700; border-top: 1px solid #000; padding-top: 4px; }",
    ".decl { margin: 20px 0 0; }",
    ".sig { display: flex; gap: 30px; margin-top: 30px; }",
    ".sig > div { flex: 1; }",
    ".line { position: relative; border-bottom: 1px solid #000; height: 44px; }",
    ".line img.sig-img { position: absolute; left: 0; bottom: 1px; max-height: 42px; max-width: 100%; }",
    "small { font-size: 8.5pt; color: #657D7F; }",
    ".ft { margin-top: auto; padding-top: 24px; display: flex; justify-content: space-between; font-size: 8pt; color: #657D7F; }",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"page\">",
    "  <div class=\"top\">",
    "    <img class=\"logo\" alt=\"NoeXa\" src=\"$logo_uri\">",
    "    <div class=\"t\"><b>Per Diem Report</b><span>Itinerary Bulletin &middot; $month_label</span></div>",
    "  </div>",
    "  <table class=\"info\">",
    "    <tr><td>Name:</td><td>$name</td></tr>",
    "    <tr><td>Office:</td><td>$office</td></tr>",
    "    <tr><td>Plate:</td><td>$plate</td></tr>",
    "  </table>",
    "  <table class=\"tb\" style=\"--k: $fit\">",
    "    <tr><th>Nº</th><th>Date</th><th>Company</th><th>Location(s)</th><th>Trip Business Goal</th><th>Start Date</th><th>#Nr Days</th><th>Specific Project?</th><th>Project</th><th class=\"r\">Amount (Per diem)</th><th class=\"r\">Total Amount</th><th class=\"r\">Nº Km</th><th class=\"r\">Unit €</th><th class=\"r\">Total €</th></tr>",
    "$rows",
    "    <tr class=\"tot\"><td colspan=\"10\">Totals</td><td class=\"r\"></td><td class=\"r\">$total_km</td><td></td><td class=\"r\">$total_trips_eur €</td></tr>",
    "  </table>",
    "  <table class=\"sum\">",
    "    <tr><td>Total debited to Projects</td><td class=\"r\">$debited €</td></tr>",
    "    <tr><td>Total NOT debited to Projects</td><td class=\"r\">$not_debited €</td></tr>",
    "    <tr class=\"g\"><td>Total receivable EUR.</td><td class=\"r\">$receivable €</td></tr>",
    "  </table>",
    "  <p class=\"decl\">I received the amount of <b>$receivable €</b> referring to the daily rates and trips described above.</p>",
    "  <div class=\"sig\">",
    "    <div><small>Signature</small><div class=\"line\">$signature_img</div><small>Date: $sign_date</small></div>",
    "    <div><small>Approval</small><div class=\"line\"></div></div>",
    "  </div>",
    "  <div class=\"ft\"><span>INTERNO</span><span>E.28 Boletim Itinerário (V03)</span></div>",
    "</div>",
    "</body>",
    "</html>",
    ""
  ].join("\n");

  var HEADERS = ["Nº", "Date", "Company", "Location(s)", "Trip Business Goal", "Start Date", "#Nr Days",
    "Specific Project?", "Project", "Amount (Per diem)", "Total Amount", "Nº Km", "Unit €", "Total €"];
  var TH_PT = 6.0, TD_PT = 7.0;     // base font sizes of the table (see TEMPLATE)
  var CELL_PAD_PT = 3.0;            // 2px left + 2px right per column
  var CONTENT_PT = 527.0;           // A4 width minus the @page side margins (186 mm)
  var NARROW = "iljtfrI1.,:;|'!() -/", WIDE = "mwMW";
  var UPPER = /^\p{Lu}$/u;
  var R = ' class="r"';

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(d) { return pad2(d.d) + "-" + MONTHS_SHORT[d.m - 1]; }
  function fmtDateFull(d) { return pad2(d.d) + "/" + pad2(d.m) + "/" + d.y; }
  function escapeHtml(s) { // html.escape(s, quote=True)
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }
  function dataUri(b64) { return "data:image/png;base64," + b64; }

  // Deliberately generous text width in em, per character (same table as renderer._em).
  function em(text) {
    var total = 0;
    Array.from(text).forEach(function (c) {
      if (WIDE.indexOf(c) >= 0) total += 0.95;
      else if (NARROW.indexOf(c) >= 0) total += 0.4;
      else if (UPPER.test(c)) total += 0.72;
      else if (c.codePointAt(0) >= 0x2E80) total += 1.1;
      else total += 0.56;
    });
    return total;
  }

  // Font scale (<= 1) so the nowrap table fits the page width; floored to 3 decimals
  // exactly like Decimal(str(x)).quantize(0.001, ROUND_FLOOR) and printed with 3 decimals.
  function fitScale(rows, headers) {
    headers = headers || HEADERS;
    var widths = headers.map(function (h) { return em(h) * TH_PT; });
    rows.forEach(function (cells) {
      cells.forEach(function (text, i) { widths[i] = Math.max(widths[i], em(text) * TD_PT * 1.05); });
    });
    var sum = 0;
    widths.forEach(function (w) { sum += w; });
    var avail = CONTENT_PT - CELL_PAD_PT * headers.length - 4;
    var x = Math.min(1.0, avail / sum);
    if (x >= 1) return "1.000";
    var s = String(x), m = /^0\.([0-9]+)$/.exec(s);
    if (!m) return "0.001"; // exponent notation: far below any real table
    return "0." + (m[1] + "000").slice(0, 3);
  }

  function tr(cells) {
    return "    <tr>" + cells.map(function (c) { return "<td" + c[1] + ">" + escapeHtml(c[0]) + "</td>"; }).join("") + "</tr>";
  }

  function sumDecimals(list) { // exact sum of {n, s} decimals
    var acc = { n: 0n, s: 0 };
    list.forEach(function (d) {
      var s = Math.max(acc.s, d.s);
      acc = { n: acc.n * BigInt("1" + "0".repeat(s - acc.s)) + d.n * BigInt("1" + "0".repeat(s - d.s)), s: s };
    });
    return acc;
  }
  function decCents(d) { // {n, s} (n >= 0) -> cents, rounded half up like Decimal.quantize
    var digits = String(d.n).padStart(d.s + 1, "0");
    return money.cents(d.s ? digits.slice(0, -d.s) + "." + digits.slice(-d.s) : digits);
  }

  function endOf(t) {
    var s = t.start ? dates.parseIso(t.start) : null;
    if (s && t.days !== null && t.days !== undefined) return dates.addDays(s, t.days);
    return t.endHint ? dates.parseIso(t.endHint) : null;
  }

  // The report's content, shared by the HTML preview and the PDF (pdf_perdiem.js): cell texts with
  // their alignment ("" or R), totals, summary amounts, fit scale and texts around the table.
  function perDiemModel(profile, trips, year, month, cfg) {
    cfg = cfg || defaultConfig;
    var rate = cfg.unit_rate;
    var rateText = money.format(money.cents(rate));

    var kmList = [], tripCents = [], cells = trips.map(function (t) {
      var hasKm = t.km !== null && t.km !== undefined;
      var end = endOf(t), start = t.start ? dates.parseIso(t.start) : null;
      var cents = hasKm ? money.cents(t.km, rate) : 0;
      if (hasKm) kmList.push(money.parse(t.km));
      tripCents.push(cents);
      return [
        [String(t.number), ""], [end ? fmtDate(end) : "", ""], [cfg.company, ""], [t.location, ""],
        [cfg.goal, ""], [start ? fmtDate(start) : "", ""],
        [t.days !== null && t.days !== undefined ? String(t.days) : "", ""],
        [t.project ? "Yes" : "No", ""], [t.project, ""],
        ["", R], ["", R],
        [hasKm ? money.format(money.cents(t.km)) : "", R], [rateText, R],
        [hasKm ? money.format(cents) : "", R]
      ];
    });
    var totalKm = money.format(decCents(sumDecimals(kmList)));
    var totalEur = 0, debited = 0;
    trips.forEach(function (t, i) { totalEur += tripCents[i]; if (t.project) debited += tripCents[i]; });
    var receivable = totalEur;
    var totalsRow = ["", "", "", "", "", "", "", "", "", "", "", totalKm, "", money.format(totalEur) + " €"];
    var fit = fitScale(cells.map(function (row) { return row.map(function (c) { return c[0]; }); }).concat([totalsRow]));
    return {
      monthLabel: MONTHS_FULL[month - 1] + " " + year,
      name: profile.name, office: profile.office, plate: profile.plate,
      headers: HEADERS.slice(),
      rightAligned: HEADERS.map(function (h, i) { return i >= 9; }),
      cells: cells.map(function (row) { return row.map(function (c) { return c[0]; }); }),
      htmlCells: cells,
      fit: fit,
      totalKm: totalKm,
      totalEur: money.format(totalEur),
      debited: money.format(debited),
      notDebited: money.format(receivable - debited),
      receivable: money.format(receivable),
      signDate: fmtDateFull({ y: year, m: month, d: dates.monthLength(year, month) })
    };
  }

  // preview.perDiemHtml(profile, trips, year, month, signaturePngBase64|null, {draft, config, logoUri})
  function perDiemHtml(profile, trips, year, month, signatureB64, opts) {
    opts = opts || {};
    var logoUri = opts.logoUri || (root_assets() && root_assets().logoDataUri) || "noexa-logo.png";
    var m = perDiemModel(profile, trips, year, month, opts.config || defaultConfig);
    var sig = signatureB64 ? '<img class="sig-img" alt="Signature" src="' + dataUri(signatureB64) + '">' : "";
    var vars = {
      month_label: escapeHtml(m.monthLabel),
      logo_uri: logoUri,
      name: escapeHtml(profile.name), office: escapeHtml(profile.office), plate: escapeHtml(profile.plate),
      fit: m.fit,
      rows: m.htmlCells.map(tr).join("\n"),
      total_km: m.totalKm,
      total_trips_eur: m.totalEur,
      debited: m.debited,
      not_debited: m.notDebited,
      receivable: m.receivable,
      signature_img: sig,
      sign_date: m.signDate
    };
    return TEMPLATE.replace(/\$([a-z_]+)/g, function (x, k) { return vars[k]; });
  }

  function root_assets() {
    var g = typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : {});
    return g.PerDiemEngine && g.PerDiemEngine.assets;
  }

  // ---------------- Expenses Report (renderer.render_expenses_html, templates/expenses.html) ----------------
  var EXPENSES_TEMPLATE = [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>Expenses Report - $month_label</title>",
    "<style>",
    "@page { size: A4; margin: 14mm 12mm 12mm 12mm; }",
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; padding: 0; background: #fff; }",
    "body { color: #000; font: 10.5pt/1.45 Calibri, \"Segoe UI\", Arial, sans-serif; }",
    ".page { width: 100%; min-height: 268mm; display: flex; flex-direction: column; }",
    ".top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #8C2585; padding-bottom: 8px; }",
    ".top img.logo { height: 52px; }",
    ".top .t { text-align: right; }",
    ".top .t b { display: block; font-size: 19pt; color: #8C2585; letter-spacing: .3px; }",
    ".top .t span { color: #657D7F; font-size: 10.5pt; }",
    "table { width: 100%; border-collapse: collapse; }",
    ".info { margin: 14px 0 4px; width: auto; }",
    ".info td { padding: 1px 12px 1px 0; border: none; font-size: 10.5pt; }",
    ".info td:first-child { width: 70px; font-weight: 700; color: #657D7F; }",
    ".tb { margin-top: 12px; }",
    ".tb thead { display: table-header-group; }",
    ".tb tr { break-inside: avoid; }",
    ".tb.iv th:last-child, .tb.iv td:last-child { padding-left: 16px; }",
    ".tb .empty { color: #657D7F; font-style: italic; }",
    "h3 { margin: 16px 0 0; font-size: 11pt; color: #8C2585; }",
    "h3 + .tb { margin-top: 4px; }",
    ".tb th, .tb td { white-space: nowrap; }",
    ".tb th { font-size: calc(6pt * var(--k, 1)); text-align: left; padding: 4px 2px; border-top: 1px solid #8C2585; border-bottom: 1px solid #8C2585; color: #8C2585; }",
    ".tb td { padding: 5px 2px; border-bottom: 1px solid #ddd; font-size: calc(7pt * var(--k, 1)); }",
    ".tb .r { text-align: right; }",
    ".tb .tot td { font-weight: 700; border-top: 1px solid #8C2585; border-bottom: 1px solid #8C2585; }",
    ".sum { width: 46%; margin: 14px 0 0 auto; }",
    ".sum td { padding: 2px 0; font-size: 10.5pt; }",
    ".sum .r { text-align: right; }",
    ".sum .g td { font-weight: 700; border-top: 1px solid #000; padding-top: 4px; }",
    ".decl { margin: 20px 0 0; }",
    ".sig { display: flex; gap: 30px; margin-top: 30px; break-inside: avoid; }",
    ".sig > div { flex: 1; }",
    ".line { position: relative; border-bottom: 1px solid #000; height: 44px; }",
    ".line img.sig-img { position: absolute; left: 0; bottom: 1px; max-height: 42px; max-width: 100%; }",
    "small { font-size: 8.5pt; color: #657D7F; }",
    ".ft { margin-top: auto; padding-top: 24px; display: flex; justify-content: space-between; font-size: 8pt; color: #657D7F; }",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"page\">",
    "  <div class=\"top\">",
    "    <img class=\"logo\" alt=\"NoeXa\" src=\"$logo_uri\">",
    "    <div class=\"t\"><b>Expenses Report <span>&middot; $month_label</span></b></div>",
    "  </div>",
    "  <table class=\"info\">",
    "    <tr><td>Name:</td><td>$name</td></tr>",
    "  </table>",
    "$expenses_section$invoices_section  <div class=\"sig\">",
    "    <div><small>Signature</small><div class=\"line\">$signature_img</div><small>Date: $sign_date</small></div>",
    "    <div><small>Approval</small><div class=\"line\"></div></div>",
    "  </div>",
    "  <div class=\"ft\"><span>INTERNO</span></div>",
    "</div>",
    "$proof_pages",
    "</body>",
    "</html>",
    ""
  ].join("\n");
  var EXPENSES_SECTION = [
    "  <h3>Expenses</h3>",
    "  <table class=\"tb ex\" style=\"--k: $fit_ex\">",
    "    <thead><tr><th>Nº</th><th>Date</th><th>Company</th><th>Description</th><th>Specific Project?</th><th>Project</th><th class=\"r\">Amount</th></tr></thead>",
    "    <tbody>",
    "$expense_rows",
    "    <tr class=\"tot\"><td colspan=\"6\">Total expenses</td><td class=\"r\">$total_expenses €</td></tr>",
    "    </tbody>",
    "  </table>",
    ""
  ].join("\n");
  var INVOICES_SECTION = [
    "  <h3>Invoices</h3>",
    "  <table class=\"tb iv\" style=\"--k: $fit_iv\">",
    "    <thead><tr><th>Nº</th><th>Invoice date</th><th class=\"r\">Invoice value</th><th>Proof</th></tr></thead>",
    "    <tbody>",
    "$invoice_rows",
    "    <tr class=\"tot\"><td colspan=\"2\">Total invoices</td><td class=\"r\">$total_invoices €</td><td></td></tr>",
    "    </tbody>",
    "  </table>",
    ""
  ].join("\n");
  var EXPENSE_HEADERS = ["Nº", "Date", "Company", "Description", "Specific Project?", "Project", "Amount"];
  var INVOICE_HEADERS = ["Nº", "Invoice date", "Invoice value", "Proof"];
  var PROOF_NAME_SHOWN = 40;

  function fill(template, vars) {
    return template.replace(/\$([a-z_]+)/g, function (x, k) { return vars[k]; });
  }

  // The proof file name as shown in the report (truncated to 40 characters, code points as Python).
  function proofDisplayName(name) {
    var chars = Array.from(name);
    return chars.length > PROOF_NAME_SHOWN ? chars.slice(0, PROOF_NAME_SHOWN).join("") + "…" : name;
  }
  function proofLabel(i) {
    return proofDisplayName(i.proof_name) + " · " + i.proof_pages + " page" + (i.proof_pages === 1 ? "" : "s");
  }

  // The Expenses Report's content, shared by the HTML preview and the PDF (pdf_expenses.js).
  // Expense: {number, date: "YYYY-MM-DD", description, project, amount: decimal string};
  // Invoice: {number, date, value: decimal string, proof_id, proof_name, proof_kind, proof_pages}.
  // Sections: Expenses when there are expenses or nothing at all; Invoices only with invoices.
  function expensesModel(profile, expenses, invoices, year, month, cfg) {
    cfg = cfg || defaultConfig;
    var totalEx = 0, totalIv = 0;
    var exCells = expenses.map(function (e) {
      var c = money.cents(e.amount);
      totalEx += c;
      return [[String(e.number), ""], [fmtDateFull(dates.parseIso(e.date)), ""], [cfg.company, ""],
        [e.description, ""], [e.project ? "Yes" : "No", ""], [e.project, ""], [money.format(c) + " €", R]];
    });
    var ivCells = invoices.map(function (i) {
      var c = money.cents(i.value);
      totalIv += c;
      return [[String(i.number), ""], [fmtDateFull(dates.parseIso(i.date)), ""], [money.format(c) + " €", R],
        [proofLabel(i), ""]];
    });
    function texts(rows) { return rows.map(function (row) { return row.map(function (c) { return c[0]; }); }); }
    var totalExText = money.format(totalEx), totalIvText = money.format(totalIv); // without " €", like the template vars
    return {
      monthLabel: MONTHS_FULL[month - 1] + " " + year,
      name: profile.name,
      showExpenses: expenses.length > 0 || invoices.length === 0,
      showInvoices: invoices.length > 0,
      expenseHeaders: EXPENSE_HEADERS.slice(),
      invoiceHeaders: INVOICE_HEADERS.slice(),
      expenseRight: [false, false, false, false, false, false, true],
      invoiceRight: [false, false, true, false],
      expenseCells: texts(exCells), invoiceCells: texts(ivCells),
      htmlExpenseCells: exCells, htmlInvoiceCells: ivCells,
      totalExpenses: totalExText, totalInvoices: totalIvText,
      fitEx: fitScale(texts(exCells).concat([["", "", "", "", "", "", totalExText + " €"]]), EXPENSE_HEADERS),
      fitIv: fitScale(texts(ivCells).concat([["", "", totalIvText + " €", ""]]), INVOICE_HEADERS),
      signDate: fmtDateFull({ y: year, m: month, d: dates.monthLength(year, month) })
    };
  }

  // preview.expensesHtml(profile, expenses, invoices, year, month, signaturePngBase64|null,
  //   {config, logoUri, proofPagesHtml}) -> the document the local app renders (proofPagesHtml is
  //   what follows the page: the preview's "N proof page(s) will be added" note).
  function expensesHtml(profile, expenses, invoices, year, month, signatureB64, opts) {
    opts = opts || {};
    var logoUri = opts.logoUri || (root_assets() && root_assets().logoDataUri) || "noexa-logo.png";
    var m = expensesModel(profile, expenses, invoices, year, month, opts.config || defaultConfig);
    var sig = signatureB64 ? '<img class="sig-img" alt="Signature" src="' + dataUri(signatureB64) + '">' : "";
    var exSection = "", ivSection = "";
    if (m.showExpenses) {
      exSection = fill(EXPENSES_SECTION, { fit_ex: m.fitEx, total_expenses: m.totalExpenses,
        expense_rows: m.htmlExpenseCells.length ? m.htmlExpenseCells.map(tr).join("\n")
          : '    <tr><td colspan="7" class="empty">No entries</td></tr>' });
    }
    if (m.showInvoices) {
      ivSection = fill(INVOICES_SECTION, { fit_iv: m.fitIv, total_invoices: m.totalInvoices,
        invoice_rows: m.htmlInvoiceCells.map(tr).join("\n") });
    }
    return fill(EXPENSES_TEMPLATE, {
      month_label: escapeHtml(m.monthLabel), logo_uri: logoUri, name: escapeHtml(profile.name),
      expenses_section: exSection, invoices_section: ivSection, signature_img: sig, sign_date: m.signDate,
      proof_pages: opts.proofPagesHtml || ""
    });
  }

  return { perDiemHtml: perDiemHtml, perDiemModel: perDiemModel, expensesHtml: expensesHtml, expensesModel: expensesModel,
    proofDisplayName: proofDisplayName, fitScale: fitScale, escapeHtml: escapeHtml, fmtDate: fmtDate, fmtDateFull: fmtDateFull };
});
