// Layout of the Per Diem PDF page: where Edge puts every text, border and image when it prints
// perdiem/templates/report.html (A4, @page margins 14/12/12/12 mm), reproduced without a browser.
//
// The model follows Chromium in CSS px (1 px = 0.75 pt) and LayoutUnits (1/64 px). It was taken
// from Edge itself (getBoundingClientRect on report.html, web/tools/measure_edge_lines.py) and is
// checked against the goldens (tests/web/golden) by tests/test_web_parity.py:
//  - the page is a flex column (margins never collapse), content box 704 px wide at (45, 53) px;
//  - line boxes: the 10.5/19/8 pt lines and every table row height come from edge_lines.js
//    (measured; 1.45 x size within 1/64 px); the baseline sits at round(ascent) + the leading
//    above the text, Calibri's win ascent being 1950/2048 em (the same in Carlito);
//  - text baselines, borders and images are snapped to whole px when painted; text x is not;
//  - the 1.5 px header rule lays out and paints as 1 px; collapsed 1 px table borders;
//  - the 14-column table uses Chromium's auto layout: each column gets its max-content width +
//    4 px padding and the 704 px are shared in proportion to those widths (nowrap: no wrapping);
//  - text in the PDF is drawn at the font size truncated to 2 decimals, as Edge writes it.
//
// layout.perDiem(model, measure, images) -> {width, height, ops} in pt, origin top-left
// (layout.expenses, further down, does the same for expenses.html, page by page, and
// layout.imageProof / layout.pdfSeparator for one proof page of perdiem/assemble.py::PROOF_STYLE).
//   model:   preview.perDiemModel(...) (texts already limited to drawable glyphs)
//   measure: (text, bold, px) -> advance width in px (kerned, as HarfBuzz in Chromium)
//   images:  {logo: {w, h}, signature: {w, h} | null} (natural pixel sizes)
//   ops:     {t: "text", x, y, size, bold, color, text, spacing} (x/y = baseline origin),
//            {t: "rect", x, y, w, h, color}, {t: "image", name, x, y, w, h}
//            (text and rect ops also carry yPx, the unsnapped y in px, for debugging)
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./edge_lines.js"));
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.layout = factory(ns.edgeLines);
  }
})(typeof self !== "undefined" ? self : this, function (edgeLines) {
  "use strict";
  var PT = 0.75;                          // pt per CSS px
  var PAGE_W = 594.96, PAGE_H = 841.92;   // the page size Edge writes for A4 (pt)
  var X0 = 45, Y0 = 53, W = 704;          // content box (px), as Edge prints the @page margins
  var PAGE_MIN_H = 268 * 96 / 25.4;       // .page { min-height: 268mm }
  var ASC = 1950 / 2048, DESC = 550 / 2048;
  var BODY = 14, TITLE = 19 * 4 / 3, SMALL = 8.5 * 4 / 3, FOOT = 8 * 4 / 3; // 10.5 / 19 / 8.5 / 8 pt
  var TH = 8, TD = 28 / 3;                // 6 pt and 7 pt in px, times the fit scale
  var LOGO_H = 52, SIG_MAX_H = 42, SIG_GAP = 30, SIG_LINE_H = 44;
  var COLORS = { purple: [0x8c, 0x25, 0x85], grey: [0x65, 0x7d, 0x7f], line: [0xdd, 0xdd, 0xdd], black: [0, 0, 0] };

  function lu(x) { return Math.round(x * 64) / 64; }          // LayoutUnit
  function px(x) { return Math.floor(x + 0.5); }               // pixel snapping
  function drawSize(f) { return Math.floor(f * 100 + 1e-6) / 100; }
  function ascent(f) { return px(f * ASC); }
  // A line box {height, base}: base = baseline from the line top.
  function formulaLine(f) {
    var h = Math.floor(1.45 * f * 64) / 64, a = ascent(f), d = px(f * DESC);
    return { height: h, base: a + Math.floor((h - a - d) / 2) };
  }
  function fixedLine(name, f) {
    var line = formulaLine(f);
    if (edgeLines && edgeLines.fixed[name]) line.height = edgeLines.fixed[name] / 64;
    line.base = ascent(f) + Math.floor((line.height - ascent(f) - px(f * DESC)) / 2);
    return line;
  }
  function tableLine(kind, k, f) {
    var r = edgeLines && edgeLines.row(kind, k);
    return r ? { height: r.height, base: r.lead + ascent(f) } : formulaLine(f);
  }

  function perDiem(m, measure, images) {
    var ops = [];
    function text(s, xPx, basePx, f, bold, color, spacing) {
      if (!s) return;
      ops.push({ t: "text", text: s, x: xPx * PT, y: px(basePx) * PT, size: drawSize(f) * PT, bold: !!bold,
                 color: COLORS[color], spacing: (spacing || 0) * PT, yPx: basePx });
    }
    function width(s, bold, f, spacing) { return measure(s, bold, f) + (spacing || 0) * Array.from(s).length; }
    function textRight(s, rightPx, basePx, f, bold, color, spacing) {
      text(s, rightPx - width(s, bold, f, spacing), basePx, f, bold, color, spacing);
    }
    function rule(x0, x1, yPx, color) { // a 1 px border
      var y = px(yPx), a = px(x0), b = px(x1);
      ops.push({ t: "rect", x: a * PT, y: y * PT, w: (b - a) * PT, h: PT, color: COLORS[color], yPx: yPx });
    }
    function image(name, x, y, w, h) {
      var x0 = px(x), y0 = px(y);
      ops.push({ t: "image", name: name, x: x0 * PT, y: y0 * PT, w: (px(x + w) - x0) * PT, h: (px(y + h) - y0) * PT });
    }
    var right = X0 + W, body = fixedLine("body", BODY), title = fixedLine("title", TITLE);

    // ---- header: logo left, title block right, 1 px purple rule ----
    var logo = images.logo;
    image("logo", X0, Y0, LOGO_H * logo.w / logo.h, LOGO_H);
    textRight("Per Diem Report", right, Y0 + title.base, TITLE, true, "purple", 0.3);
    textRight("Itinerary Bulletin · " + m.monthLabel, right, Y0 + title.height + body.base, BODY, false, "grey");
    var y = Y0 + Math.max(LOGO_H, title.height + body.height) + 8;
    rule(X0, right, y, "purple");
    y += 1;

    // ---- Name / Office / Plate (label column 70 px) ----
    y += 14;
    [["Name:", m.name], ["Office:", m.office], ["Plate:", m.plate]].forEach(function (r) {
      text(r[0], X0, y + 1 + body.base, BODY, true, "grey");
      text(r[1], X0 + 70, y + 1 + body.base, BODY, false, "black");
      y += body.height + 2;
    });
    y += 4 + 12;

    // ---- the 14-column table ----
    var k = parseFloat(m.fit), fth = TH * k, ftd = TD * k;
    var th = tableLine("th", k, fth), td = tableLine("td", k, ftd);
    var n = m.headers.length, maxW = [], i;
    function cellW(s, bold, f) { return s ? Math.ceil(measure(s, bold, f) * 64) / 64 : 0; }
    for (i = 0; i < n; i++) maxW[i] = cellW(m.headers[i], true, fth) + 4;
    m.cells.forEach(function (row) {
      row.forEach(function (s, j) { maxW[j] = Math.max(maxW[j], cellW(s, false, ftd) + 4); });
    });
    var totals = { 11: m.totalKm, 13: m.totalEur + " €" };
    Object.keys(totals).forEach(function (j) { maxW[j] = Math.max(maxW[j], cellW(totals[j], true, ftd) + 4); });
    var sumMax = maxW.reduce(function (a, b) { return a + b; }, 0);
    var colX = [X0], acc = 0;
    for (i = 0; i < n; i++) {
      acc += sumMax < W ? maxW[i] * W / sumMax : maxW[i]; // wider than the page: Chromium overflows
      colX.push(X0 + lu(acc));
    }
    var tableRight = colX[n];
    function rowTexts(cells, bold, f, base, color) {
      cells.forEach(function (s, j) {
        if (!s) return;
        if (m.rightAligned[j]) textRight(s, colX[j + 1] - 2, base, f, bold, color);
        else text(s, colX[j] + 2, base, f, bold, color);
      });
    }
    rule(X0, tableRight, y, "purple");                 // header top border
    y += 1 + 4;
    rowTexts(m.headers, true, fth, y + th.base, "purple");
    y += th.height + 4;
    rule(X0, tableRight, y, "purple");                 // header bottom border
    y += 1;
    m.cells.forEach(function (row) {
      y += 5;
      rowTexts(row, false, ftd, y + td.base, "black");
      y += td.height + 5;
      rule(X0, tableRight, y, "line");                 // #ddd (wins over the totals' top border)
      y += 1;
    });
    y += 5;
    var tb = y + td.base;
    text("Totals", X0 + 2, tb, ftd, true, "black");
    textRight(totals[11], colX[12] - 2, tb, ftd, true, "black");
    textRight(totals[13], colX[14] - 2, tb, ftd, true, "black");
    y += td.height + 5;
    rule(X0, tableRight, y, "purple");
    y += 1;

    // ---- summary (46 % wide, right) ----
    y += 14;
    var sumLeft = right - lu(0.46 * W);
    [["Total debited to Projects", m.debited], ["Total NOT debited to Projects", m.notDebited]].forEach(function (r) {
      text(r[0], sumLeft, y + 2 + body.base, BODY, false, "black");
      textRight(r[1] + " €", right, y + 2 + body.base, BODY, false, "black");
      y += body.height + 4;
    });
    rule(sumLeft, right, y, "black");
    y += 1 + 4;
    text("Total receivable EUR.", sumLeft, y + body.base, BODY, true, "black");
    textRight(m.receivable + " €", right, y + body.base, BODY, true, "black");
    y += body.height + 2;

    // ---- "I received the amount of ..." (three runs: regular, bold, regular) ----
    y += 20;
    var db = y + body.base, dx = X0;
    [["I received the amount of ", false], [m.receivable + " €", true],
     [" referring to the daily rates and trips described above.", false]].forEach(function (p) {
      text(p[0], dx, db, BODY, p[1], "black");
      dx += measure(p[0], p[1], BODY);
    });
    y += body.height;

    // ---- Signature / Approval (8.5 pt text on 10.5 pt lines) ----
    y += 30;
    var colW = (W - SIG_GAP) / 2, x2 = X0 + colW + SIG_GAP;
    text("Signature", X0, y + body.base, SMALL, false, "grey");
    text("Approval", x2, y + body.base, SMALL, false, "grey");
    y += body.height;
    if (images.signature) { // img.sig-img: bottom 1px in the 43 px padding box, max 42 px x 100 %
      var sg = images.signature, s = Math.min(1, SIG_MAX_H / sg.h, colW / sg.w);
      image("signature", X0, y + SIG_LINE_H - 2 - sg.h * s, sg.w * s, sg.h * s);
    }
    rule(X0, X0 + colW, y + SIG_LINE_H - 1, "black");
    rule(x2, right, y + SIG_LINE_H - 1, "black");
    y += SIG_LINE_H;
    text("Date: " + m.signDate, X0, y + body.base, SMALL, false, "grey");
    y += body.height;

    // ---- footer at the bottom of the 268 mm page box ----
    var foot = fixedLine("foot", FOOT);
    var pageBottom = Y0 + Math.max(lu(PAGE_MIN_H), y - Y0 + 24 + foot.height);
    var fb = pageBottom - foot.height + foot.base;
    text("INTERNO", X0, fb, FOOT, false, "grey");
    textRight("E.28 Boletim Itinerário (V03)", right, fb, FOOT, false, "grey");

    return { width: PAGE_W, height: PAGE_H, ops: ops };
  }

  // Chromium's auto table layout for a nowrap table at width:100% (see the header comment):
  // max-content + padding per column, colspan cells widen their columns only when they do not fit
  // (the excess shared in proportion to the columns' widths), then 704 px shared in proportion.
  //   cols: [{pad}], cells: [{col, span, text, bold, f}] -> [x of each column edge] (n + 1 values)
  function tableColumns(cols, cells, measure) {
    var n = cols.length, maxW = cols.map(function (c) { return c.pad; }), i;
    function cellW(s, bold, f) { return s ? Math.ceil(measure(s, bold, f) * 64) / 64 : 0; }
    cells.filter(function (c) { return c.span === 1; }).forEach(function (c) {
      maxW[c.col] = Math.max(maxW[c.col], cellW(c.text, c.bold, c.f) + cols[c.col].pad);
    });
    cells.filter(function (c) { return c.span > 1; }).forEach(function (c) {
      var need = cellW(c.text, c.bold, c.f) + cols[c.col].pad, have = 0, j;
      for (j = c.col; j < c.col + c.span; j++) have += maxW[j];
      if (need <= have) return;
      var extra = need - have;
      for (j = c.col; j < c.col + c.span; j++) maxW[j] += have ? extra * maxW[j] / have : extra / c.span;
    });
    var sumMax = maxW.reduce(function (a, b) { return a + b; }, 0);
    var colX = [X0], acc = 0;
    for (i = 0; i < n; i++) {
      acc += sumMax < W ? maxW[i] * W / sumMax : maxW[i]; // wider than the page: Chromium overflows
      colX.push(X0 + lu(acc));
    }
    return colX;
  }

  // layout.expenses(model, measure, images) -> {width, height, pages: [ops, ...]} for
  // perdiem/templates/expenses.html (model: preview.expensesModel), page by page, as Edge breaks it:
  //  - the h3 "Expenses" and the table always start on page 1 (only the Name block is above them);
  //  - the 9-column table (auto layout, nowrap, fit scale m.fit) repeats its header row (thead) on
  //    every page; a body row (break-inside: avoid) that does not fit goes to the next page under
  //    the repeated header, with the previous row's #ddd border painted over the header's bottom
  //    border;
  //  - the LAST data row (or "No entries"), the "Total expenses" row and the end row (the totals
  //    summary + the signature block, with 40 px reserved at its bottom for the footer) are one
  //    <tbody class="tail"> with break-inside: avoid: when the whole group does not fit, it moves as
  //    a whole to the next page under the repeated header (so the total row and the summary are
  //    never alone on a page);
  //  - the footer (position: absolute; bottom: 0 in .page) ends at the bottom of the 268 mm page box
  //    on a one-page report, and at the end of the table (in the reserved 40 px) otherwise.
  // CONTENT_H: where Edge ends a page, measured with Edge (web Task 6, and the 1..130 sweep of the
  // v3 table, tests/test_web_parity.py): A4 minus the 14 + 12 mm margins (271 mm = 1024.25 px) plus
  // 45/64 px; the measured extra lies in (0.656, 0.766] px.
  var CONTENT_H = lu(271 * 96 / 25.4) + 45 / 64;
  var H3 = 11 * 4 / 3;             // h3: 11 pt
  var END_PAD = 40;                // tr.end > td { padding-bottom: 40px } (the footer's space)
  function expenses(m, measure, images) {
    var pages = [], ops, pageTop = Y0;
    function newPage() { ops = []; pages.push(ops); }
    newPage();
    function text(s, xPx, basePx, f, bold, color, spacing, italic) {
      if (!s) return;
      ops.push({ t: "text", text: s, x: xPx * PT, y: px(basePx) * PT, size: drawSize(f) * PT, bold: !!bold,
                 italic: !!italic, color: COLORS[color], spacing: (spacing || 0) * PT, yPx: basePx });
    }
    function width(s, bold, f, spacing) { return measure(s, bold, f) + (spacing || 0) * Array.from(s).length; }
    function textRight(s, rightPx, basePx, f, bold, color, spacing) {
      text(s, rightPx - width(s, bold, f, spacing), basePx, f, bold, color, spacing);
      return rightPx - width(s, bold, f, spacing);
    }
    function rule(x0, x1, yPx, color) {
      var y = px(yPx), a = px(x0), b = px(x1);
      ops.push({ t: "rect", x: a * PT, y: y * PT, w: (b - a) * PT, h: PT, color: COLORS[color], yPx: yPx });
    }
    function image(name, x, y, w, h) {
      var x0 = px(x), y0 = px(y);
      ops.push({ t: "image", name: name, x: x0 * PT, y: y0 * PT, w: (px(x + w) - x0) * PT, h: (px(y + h) - y0) * PT });
    }
    var right = X0 + W, body = fixedLine("body", BODY), title = fixedLine("title", TITLE);
    var h3 = fixedLine("h3", H3), foot = fixedLine("foot", FOOT);

    // ---- header: logo left, "Expenses Report · Month Year" right (one line), 1 px purple rule ----
    var logo = images.logo;
    image("logo", X0, Y0, LOGO_H * logo.w / logo.h, LOGO_H);
    var tb = Y0 + title.base;
    var spanX = textRight("· " + m.monthLabel, right, tb, BODY, true, "grey", 0.3);
    textRight("Expenses Report ", spanX, tb, TITLE, true, "purple", 0.3);
    var y = Y0 + Math.max(LOGO_H, title.height) + 8;
    rule(X0, right, y, "purple");
    y += 1;

    // ---- Name (label column 70 px), margins 14 / 4 ----
    y += 14;
    text("Name:", X0, y + 1 + body.base, BODY, true, "grey");
    text(m.name, X0 + 70, y + 1 + body.base, BODY, false, "black");
    y += body.height + 2 + 4;

    // ---- h3 (margin 16 px), then the table (margin 4 px) ----
    y += 16;
    text("Expenses", X0, y + h3.base, H3, true, "purple");
    y += h3.height + 4;

    var k = parseFloat(m.fit), fth = TH * k, ftd = TD * k, th = tableLine("th", k, fth), td = tableLine("td", k, ftd);
    var n = m.headers.length, cells = [], rows = m.cells, empty = !rows.length;
    m.headers.forEach(function (s, j) { cells.push({ col: j, span: 1, text: s, bold: true, f: fth }); });
    rows.forEach(function (row) { row.forEach(function (s, j) { cells.push({ col: j, span: 1, text: s, bold: false, f: ftd }); }); });
    if (empty) cells.push({ col: 0, span: n, text: "No entries", bold: false, f: ftd });
    cells.push({ col: 0, span: n - 1, text: "Total expenses", bold: true, f: ftd });
    cells.push({ col: n - 1, span: 1, text: m.total + " €", bold: true, f: ftd });
    var colX = tableColumns(m.headers.map(function () { return { pad: 4 }; }), cells, measure), tableRight = colX[n];
    function rowTexts(list, bold, f, base, color) {
      list.forEach(function (s, j) {
        if (!s) return;
        if (m.rightAligned[j]) textRight(s, colX[j + 1] - 2, base, f, bold, color);
        else text(s, colX[j] + 2, base, f, bold, color);
      });
    }
    var headH = 1 + 4 + th.height + 4 + 1, rowH = 5 + td.height + 5 + 1;
    function header(top, continued) {
      rule(X0, tableRight, top, "purple");
      rowTexts(m.headers, true, fth, top + 1 + 4 + th.base, "purple");
      rule(X0, tableRight, top + 1 + 4 + th.height + 4, "purple");
      if (continued) rule(X0, tableRight, top + 1 + 4 + th.height + 4, "line"); // the previous row's border
      y = top + headH;
    }
    // What does not fit in the rest of the page (h px at y) goes to the next one, under the header.
    function ensure(h) {
      if (y + h > pageTop + CONTENT_H) {
        newPage();
        header(pageTop, true);
      }
    }
    function dataRow(row) {
      rowTexts(row, false, ftd, y + 5 + td.base, "black");
      y += 5 + td.height + 5;
      rule(X0, tableRight, y, "line");
      y += 1;
    }
    header(y, false);
    rows.slice(0, Math.max(rows.length - 1, 0)).forEach(function (row) { ensure(rowH); dataRow(row); });

    // ---- the tail: last row + total row + end row (summary and signature), never split ----
    var sumH = 14 + 2 * (2 + body.height + 2) + 1 + 4 + body.height + 2;
    var sigH = 30 + body.height + SIG_LINE_H + body.height;
    ensure(rowH + rowH + sumH + sigH + END_PAD);
    if (empty) {
      text("No entries", X0 + 2, y + 5 + td.base, ftd, false, "grey", 0, true);
      y += 5 + td.height + 5;
      rule(X0, tableRight, y, "line");
      y += 1;
    } else {
      dataRow(rows[rows.length - 1]);
    }
    var totBase = y + 5 + td.base;
    text("Total expenses", X0 + 2, totBase, ftd, true, "black");
    textRight(m.total + " €", tableRight - 2, totBase, ftd, true, "black");
    y += 5 + td.height + 5;
    rule(X0, tableRight, y, "purple");
    y += 1;

    // summary (.sum: 46 % of the end cell, right-aligned, margin-top 14 px)
    y += 14;
    var cellW = tableRight - X0, sumLeft = tableRight - lu(0.46 * cellW);
    [["Total debited to Projects", m.debited], ["Total NOT debited to Projects", m.notDebited]].forEach(function (r) {
      text(r[0], sumLeft, y + 2 + body.base, BODY, false, "black");
      textRight(r[1] + " €", tableRight, y + 2 + body.base, BODY, false, "black");
      y += body.height + 4;
    });
    rule(sumLeft, tableRight, y, "black");
    y += 1 + 4;
    text("Total receivable EUR.", sumLeft, y + body.base, BODY, true, "black");
    textRight(m.receivable + " €", tableRight, y + body.base, BODY, true, "black");
    y += body.height + 2;

    // Signature / Approval (8.5 pt text on 10.5 pt lines), margin-top 30 px
    y += 30;
    var colW = (cellW - SIG_GAP) / 2, x2 = X0 + colW + SIG_GAP;
    text("Signature", X0, y + body.base, SMALL, false, "grey");
    text("Approval", x2, y + body.base, SMALL, false, "grey");
    y += body.height;
    if (images.signature) { // img.sig-img: bottom 1px in the 43 px padding box, max 42 px x 100 %
      var sg = images.signature, s = Math.min(1, SIG_MAX_H / sg.h, colW / sg.w);
      image("signature", X0, y + SIG_LINE_H - 2 - sg.h * s, sg.w * s, sg.h * s);
    }
    rule(X0, X0 + colW, y + SIG_LINE_H - 1, "black");
    rule(x2, tableRight, y + SIG_LINE_H - 1, "black");
    y += SIG_LINE_H;
    text("Date: " + m.signDate, X0, y + body.base, SMALL, false, "grey");
    y += body.height + END_PAD;

    // ---- footer: at the bottom of .page (min-height 268 mm on one page) ----
    var pageBottom = pages.length === 1 ? Math.max(Y0 + lu(PAGE_MIN_H), y) : y;
    text("INTERNO", X0, pageBottom - foot.height + foot.base, FOOT, false, "grey");

    return { width: PAGE_W, height: PAGE_H, pages: pages };
  }

  // ---- an image proof page (assemble.proof_pages_html, PROOF_STYLE): a new page; the title in an
  // 8 mm line (bold 11 pt purple, one line, an ellipsis if too long), then the 243 mm box with the
  // image centred at its natural size in CSS px, scaled down only to fit (max-width/max-height
  // 100 %, object-fit: contain); the image rectangle is snapped to whole px like Edge paints it.
  //   imageProof(title, natural {w, h}, measure) -> {width, height, ops} (the image op: "proof")
  var PROOF_TITLE_H = lu(8 * 96 / 25.4), PROOF_BOX_H = lu(243 * 96 / 25.4), PROOF_TITLE = 11 * 4 / 3;
  function proofTitle(ops, title, measure) {
    var f = PROOF_TITLE, a = ascent(f), d = px(f * DESC);
    var base = Y0 + a + Math.floor((PROOF_TITLE_H - a - d) / 2);
    var s = title;
    if (measure(s, true, f) > W) {
      var chars = Array.from(s);
      while (chars.length && measure(chars.join("") + "…", true, f) > W) chars.pop();
      s = chars.join("") + "…";
    }
    ops.push({ t: "text", text: s, x: X0 * PT, y: px(base) * PT, size: drawSize(f) * PT, bold: true,
               color: COLORS.purple, spacing: 0, yPx: base });
  }
  function imageProof(title, natural, measure) {
    var ops = [];
    proofTitle(ops, title, measure);
    var k = Math.min(1, W / natural.w, PROOF_BOX_H / natural.h);
    var w = lu(natural.w * k), h = lu(natural.h * k);
    var x = X0 + (W - w) / 2, y = Y0 + PROOF_TITLE_H + (PROOF_BOX_H - h) / 2;
    var x0 = px(x), y0 = px(y);
    ops.push({ t: "image", name: "proof", x: x0 * PT, y: y0 * PT, w: (px(x + w) - x0) * PT, h: (px(y + h) - y0) * PT });
    return { width: PAGE_W, height: PAGE_H, ops: ops };
  }

  // ---- the separator page of a PDF proof (the same PROOF_STYLE page): the title "Proof for
  // expense N[ (k of m)] · attached PDF (p pages)", then the file name as .note (11 pt grey, one line box of
  // 1.45 x size) centred both ways in the 243 mm flex box; the proof's own pages follow it.
  //   pdfSeparator(title, note, measure) -> {width, height, ops}
  function pdfSeparator(title, note, measure) {
    var ops = [];
    proofTitle(ops, title, measure);
    var f = PROOF_TITLE, line = formulaLine(f);
    var w = Math.ceil(measure(note, false, f) * 64) / 64;        // the flex item: its max-content width
    var x = X0 + lu((W - w) / 2), top = Y0 + PROOF_TITLE_H + lu((PROOF_BOX_H - line.height) / 2);
    var base = top + line.base;
    if (note) {
      ops.push({ t: "text", text: note, x: x * PT, y: px(base) * PT, size: drawSize(f) * PT, bold: false,
                 color: COLORS.grey, spacing: 0, yPx: base });
    }
    return { width: PAGE_W, height: PAGE_H, ops: ops };
  }

  return { perDiem: perDiem, expenses: expenses, imageProof: imageProof, pdfSeparator: pdfSeparator,
    PAGE_W: PAGE_W, PAGE_H: PAGE_H, COLORS: COLORS };
});
