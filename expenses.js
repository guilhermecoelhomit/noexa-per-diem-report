(function () {
  "use strict";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var MAX_CENTS = 9999999, MAX_ROWS = 20;
  var L = window.PerDiemLogic, C = window.PerDiemCommon, api = C.api, errText = C.errText;
  var $ = function (id) { return document.getElementById(id); };
  var state = { year: 0, month: 0, expenses: [], invoices: [], editing: -1, dead: false,
    busy: false, profileLoaded: false, profileOk: false };
  var sig = null; // the shared Signature card, created at start
  var previewSeq = 0, previewTimer = null, touched = false;
  // Server messages that start with "Expense N:" / "Invoice N:" are shown under that row.
  var rowErrors = { e: {}, i: {} };
  var projectOn = false;

  var errSource = ""; // who raised the visible error ("preview" errors are cleared by a good preview)
  function showError(msg, src) {
    var box = $("error-box");
    box.textContent = msg || "";
    box.hidden = !msg;
    errSource = msg ? (src || "") : "";
  }
  function changed() { rowErrors = { e: {}, i: {} }; resetSave(); renderExpensesOnly(); schedulePreview(); }
  // "Expense N: ..." / "Invoice N: ..." lines go under their row; the rest stays in the error box.
  function showServerError(text, src) {
    var rest = [];
    rowErrors = { e: {}, i: {} };
    String(text).split("\n").forEach(function (line) {
      var m = /^(Expense|Invoice) (\d+): (.*)$/.exec(line);
      if (m) rowErrors[m[1] === "Expense" ? "e" : "i"][m[2]] = m[3];
      else rest.push(line);
    });
    renderExpensesOnly();
    showError(rest.join("\n"), src);
    var bad = document.querySelector(".elist .x-err"); // keep the failing row in view
    if (bad && bad.scrollIntoView) bad.scrollIntoView({ block: "nearest" });
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function fmtDate(iso) {
    var p = String(iso).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : String(iso);
  }
  function cents(e) { return L.parseAmount(e.amount, MAX_CENTS) || 0; }

  // ---- the entry row (typing never disables an input) ----
  var seg = (function () {
    var holder = $("entry-project");
    holder.textContent = "";
    var btns = [false, true].map(function (val) {
      var b = document.createElement("button"); b.type = "button"; b.className = "seg-btn";
      b.textContent = val ? "Yes" : "No";
      b.addEventListener("click", function () {
        if (state.dead) return;
        setProject(val);
        entryChanged();
        if (val) $("entry-project-name").focus();
      });
      holder.appendChild(b); return b;
    });
    return {
      set: function (v) {
        btns[0].classList.toggle("on", !v); btns[1].classList.toggle("on", v);
        btns[0].setAttribute("aria-pressed", String(!v)); btns[1].setAttribute("aria-pressed", String(v));
      }
    };
  })();
  function setProject(on) {
    projectOn = !!on;
    seg.set(projectOn);
    $("entry-project-name").hidden = !projectOn;
    if (!projectOn) $("entry-project-name").value = "";
  }
  function readEntry() {
    return { date: $("entry-date").value, description: $("entry-description").value, projectOn: projectOn,
      project: $("entry-project-name").value, amount: $("entry-amount").value };
  }
  function writeEntry(e) {
    $("entry-date").value = e.date; $("entry-description").value = e.description;
    $("entry-amount").value = e.amount; setProject(e.projectOn);
    $("entry-project-name").value = e.projectOn ? e.project : "";
  }
  function entryChanged() {
    touched = true;
    refreshEntry();
  }
  function refreshEntry() {
    var e = readEntry(), issues = L.expenseIssues(e);
    var full = state.expenses.length >= MAX_ROWS && state.editing < 0;
    $("btn-add-entry").disabled = state.dead || state.busy || issues.length > 0 || full;
    $("entry-hint").textContent = full ? L.expensesCountIssue(MAX_ROWS + 1, 0) : (touched && issues.length ? issues[0] : "");
    $("entry-date").classList.toggle("invalid", touched && !L.isoDateOk(e.date));
    $("entry-amount").classList.toggle("invalid", touched && L.parseAmount(e.amount, MAX_CENTS) === null);
    $("btn-cancel-entry").hidden = state.editing < 0;
    refreshSave();
  }
  function clearEntry(keepDate) {
    var d = keepDate ? $("entry-date").value : todayIso();
    writeEntry({ date: d, description: "", projectOn: false, project: "", amount: "" });
    touched = false;
    refreshEntry();
  }

  // ---- the list ----
  function renderExpensesOnly() { render(); renderInvoices(); }
  function render() {
    var ul = $("expenses-list");
    ul.textContent = "";
    state.expenses.forEach(function (e, i) {
      var li = document.createElement("li");
      if (i === state.editing) li.className = "editing";
      var el = function (cls, text) {
        var s = document.createElement("span"); s.className = cls; s.textContent = text; li.appendChild(s); return s;
      };
      el("x-num", String(i + 1));
      el("x-date", fmtDate(e.date));
      el("x-desc", e.description).title = e.description;
      el("x-amt", L.formatCents(cents(e)) + " €");
      var btn = function (label, fn) {
        var b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = label;
        b.setAttribute("aria-label", label + " expense " + (i + 1));
        b.addEventListener("click", function () { if (!state.dead) fn(); });
        li.appendChild(b);
      };
      btn("Edit", function () { startEdit(i); });
      btn("Remove", function () { removeAt(i); });
      if (e.projectOn) el("x-proj", "Project: " + e.project);
      if (rowErrors.e[i + 1]) el("x-err", rowErrors.e[i + 1]);
      ul.appendChild(li);
    });
    $("expense-total").textContent = L.formatCents(L.sumCents(state.expenses.map(cents))) + " €";
    refreshEntry();
  }
  function startEdit(i) {
    state.editing = i;
    writeEntry(state.expenses[i]);
    touched = false;
    render();
    $("entry-description").focus();
  }
  function stopEdit() { state.editing = -1; }
  function removeAt(i) {
    state.expenses.splice(i, 1);
    if (state.editing === i) { stopEdit(); clearEntry(true); }
    else if (state.editing > i) state.editing--;
    changed();
  }
  function commitEntry() {
    var e = readEntry();
    if (state.dead || !L.isExpenseEntryComplete(e)) return;
    var item = { date: e.date, description: e.description.trim(), projectOn: e.projectOn,
      project: e.projectOn ? e.project.trim() : "", amount: e.amount.trim() };
    if (state.editing >= 0) state.expenses[state.editing] = item;
    else if (state.expenses.length < MAX_ROWS) state.expenses.push(item);
    else return;
    stopEdit();
    clearEntry(true);
    changed();
    $("entry-description").focus();
  }
  $("btn-add-entry").addEventListener("click", commitEntry);
  $("btn-cancel-entry").addEventListener("click", function () { stopEdit(); clearEntry(true); render(); });
  ["entry-date", "entry-description", "entry-amount", "entry-project-name"].forEach(function (id) {
    $(id).addEventListener("input", entryChanged);
    $(id).addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitEntry(); }
    });
  });

  // ---- invoices (date, value, proof uploaded at once; the server owns the proof's name/kind/pages) ----
  var inv = { editing: -1, proof: null, uploading: false, proofError: "", touched: false };
  var uploadSeq = 0;
  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function readInvoice() {
    return { date: $("invoice-date").value, value: $("invoice-value").value,
      proofId: inv.proof ? inv.proof.id : "" };
  }
  function proofSizes() {
    return state.invoices.filter(function (x, i) { return i !== inv.editing; })
      .map(function (x) { return x.proofSize; });
  }
  function setProofStatus() {
    var el = $("invoice-proof-status");
    el.className = "proof-status";
    if (inv.uploading) el.textContent = "Uploading…";
    else if (inv.proofError) {
      el.textContent = inv.proofError + (inv.proof ? " Keeping " + inv.proof.name + "." : "");
      el.classList.add("bad");
    }
    else if (inv.proof) {
      el.textContent = "✓ " + inv.proof.name + " · " + fmtSize(inv.proof.size) +
        (inv.proof.kind === "pdf" ? " · " + inv.proof.pages + (inv.proof.pages === 1 ? " page" : " pages") : "");
      el.classList.add("ok");
    } else el.textContent = "No proof attached (JPG, PNG or PDF, up to 8 MB)";
    el.title = el.textContent;
  }
  function refreshInvoiceEntry() {
    var e = readInvoice(), issues = L.invoiceIssues(e);
    var full = state.invoices.length >= MAX_ROWS && inv.editing < 0;
    $("btn-add-invoice").disabled = state.dead || state.busy || inv.uploading || issues.length > 0 || full;
    var hint = full ? L.expensesCountIssue(0, MAX_ROWS + 1) : (inv.touched && issues.length ? issues[0] : "");
    $("invoice-hint").textContent = inv.uploading ? "" : hint;
    $("invoice-date").classList.toggle("invalid", inv.touched && !L.isoDateOk(e.date));
    $("invoice-value").classList.toggle("invalid", inv.touched && L.parseAmount(e.value, MAX_CENTS) === null);
    $("btn-cancel-invoice").hidden = inv.editing < 0;
    $("btn-attach-proof").disabled = state.dead || state.busy || inv.uploading;
    setProofStatus();
    refreshSave();
  }
  function invoiceChanged() { inv.touched = true; refreshInvoiceEntry(); }
  function writeInvoice(v, proof) {
    $("invoice-date").value = v.date; $("invoice-value").value = v.value;
    inv.proof = proof; inv.proofError = ""; inv.uploading = false; uploadSeq++;
    inv.touched = false;
  }
  function clearInvoiceEntry(keepDate) {
    writeInvoice({ date: keepDate ? $("invoice-date").value : todayIso(), value: "" }, null);
    refreshInvoiceEntry();
  }
  function invCents(v) { return L.parseAmount(v.value, MAX_CENTS) || 0; }
  function renderInvoices() {
    var ul = $("invoices-list");
    ul.textContent = "";
    state.invoices.forEach(function (v, i) {
      var li = document.createElement("li");
      if (i === inv.editing) li.className = "editing";
      var el = function (cls, text) {
        var x = document.createElement("span"); x.className = cls; x.textContent = text; li.appendChild(x); return x;
      };
      el("x-num", String(i + 1));
      el("x-date", fmtDate(v.date));
      el("x-desc", v.proofName).title = v.proofName;
      el("x-amt", L.formatCents(invCents(v)) + " €");
      var btn = function (label, fn) {
        var b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = label;
        b.setAttribute("aria-label", label + " invoice " + (i + 1));
        b.addEventListener("click", function () { if (!state.dead) fn(); });
        li.appendChild(b);
      };
      btn("Edit", function () { startInvoiceEdit(i); });
      btn("Remove", function () { removeInvoice(i); });
      el("x-sub", fmtSize(v.proofSize) + (v.proofKind === "pdf" ? " · PDF, " + v.proofPages + (v.proofPages === 1 ? " page" : " pages") : " · image"));
      if (rowErrors.i[i + 1]) el("x-err", rowErrors.i[i + 1]);
      ul.appendChild(li);
    });
    $("invoice-total").textContent = L.formatCents(L.sumCents(state.invoices.map(invCents))) + " €";
    refreshInvoiceEntry();
  }
  function startInvoiceEdit(i) {
    var v = state.invoices[i];
    inv.editing = i;
    writeInvoice(v, { id: v.proofId, name: v.proofName, size: v.proofSize, kind: v.proofKind, pages: v.proofPages });
    renderInvoices();
  }
  function removeInvoice(i) {
    state.invoices.splice(i, 1); // the proof file is only dropped client-side (the server prunes it later)
    if (inv.editing === i) { inv.editing = -1; clearInvoiceEntry(true); }
    else if (inv.editing > i) inv.editing--;
    changed();
  }
  function commitInvoice() {
    var e = readInvoice();
    if (state.dead || inv.uploading || !inv.proof || !L.isInvoiceEntryComplete(e)) return;
    var item = { date: e.date, value: e.value.trim(), proofId: inv.proof.id, proofName: inv.proof.name,
      proofSize: inv.proof.size, proofKind: inv.proof.kind, proofPages: inv.proof.pages };
    if (inv.editing >= 0) state.invoices[inv.editing] = item;
    else if (state.invoices.length < MAX_ROWS) state.invoices.push(item);
    else return;
    inv.editing = -1;
    clearInvoiceEntry(true);
    changed();
    $("invoice-value").focus();
  }
  function applyProof(outcome) {
    var r = L.proofAttachResult(inv.proof, outcome); // a failed file never drops the proof already there
    inv.proof = r.proof; inv.proofError = r.error;
    refreshInvoiceEntry();
  }
  async function uploadProof(file) {
    if (inv.uploading || state.busy || state.dead) return;
    var issue = L.proofBudgetIssue(proofSizes(), file.size);
    if (issue) { applyProof({ issue: issue }); return; }
    var fname;
    try { fname = encodeURIComponent(file.name); }
    catch (x) { applyProof({ error: "The file name is not valid." }); return; }
    var seq = ++uploadSeq;
    inv.uploading = true; inv.proofError = "";
    refreshInvoiceEntry();
    var res = await C.proofUpload(file);
    if (seq !== uploadSeq) return; // the entry was cleared or edited meanwhile
    inv.uploading = false;
    applyProof(res.ok ? { info: res.data } : { error: errText(res.data, "Could not upload the file (error " + res.status + ").") });
  }
  $("btn-attach-proof").addEventListener("click", function () { if (!state.dead) $("invoice-file").click(); });
  $("invoice-file").addEventListener("change", function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (file && !state.dead && !state.busy && !inv.uploading) uploadProof(file);
  });
  $("btn-add-invoice").addEventListener("click", commitInvoice);
  $("btn-cancel-invoice").addEventListener("click", function () { inv.editing = -1; clearInvoiceEntry(true); renderInvoices(); });
  ["invoice-date", "invoice-value"].forEach(function (id) {
    $(id).addEventListener("input", invoiceChanged);
    $(id).addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitInvoice(); }
    });
  });

  // ---- period ----
  function initPeriod() {
    var ms = $("period-month"), ys = $("period-year"), now = new Date(), o;
    MONTHS.forEach(function (m, i) {
      o = document.createElement("option"); o.value = String(i + 1); o.textContent = m; ms.appendChild(o);
    });
    for (var y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
      o = document.createElement("option"); o.value = String(y); o.textContent = String(y); ys.appendChild(o);
    }
    ms.value = String(now.getMonth() + 1);
    ys.value = String(now.getFullYear());
    readPeriod();
  }
  function readPeriod() {
    state.month = parseInt($("period-month").value, 10);
    state.year = parseInt($("period-year").value, 10);
  }
  ["period-month", "period-year"].forEach(function (id) {
    $(id).addEventListener("change", function () { readPeriod(); resetSave(); schedulePreview(); });
  });

  // ---- preview (debounced; a background request never locks the inputs) ----
  var pv = C.PreviewFit({ area: "preview-area", scaler: "preview-scaler", clip: "preview-clip", frame: "preview-frame" });
  var fitPreview = pv.fit;
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(loadPreview, 500);
  }
  async function loadPreview() {
    previewTimer = null;
    if (state.dead) return;
    var seq = ++previewSeq;
    var r = await api("POST", "/api/expenses/preview", L.toExpensesPayload(state), true);
    if (seq !== previewSeq) return; // stale response
    if (!r.ok) { showServerError(errText(r.data, "Could not generate the preview (error " + r.status + ")."), "preview"); return; }
    if (errSource === "preview") showError(""); // never wipe a save/draft error
    pv.show(r.data);
  }

  // ---- busy lock: heavy operations (save, signature, draft) lock the controls; typing never does ----
  function lockControls() {
    var lock = state.dead || state.busy;
    Array.prototype.forEach.call(document.querySelectorAll("button, select, input.fld"), function (x) {
      if (!x.closest(".profile-dialog")) x.disabled = lock;
    });
    if (!lock) { refreshEntry(); refreshInvoiceEntry(); }
    refreshSave();
  }
  async function guarded(fn) {
    if (state.dead || state.busy) return;
    showError("");
    state.busy = true;
    lockControls();
    try { await fn(); }
    catch (e) { showError("Unexpected error: " + (e && e.message ? e.message : e)); }
    finally { state.busy = false; lockControls(); }
  }
  // Generate PDF needs: a signature, a valid Name, at least one entry, no row being edited, no upload running.
  function blocked() {
    return (!state.expenses.length && !state.invoices.length) || state.editing >= 0 || inv.editing >= 0
      || inv.uploading || !state.profileOk;
  }
  function refreshSave() {
    var lock = state.dead || state.busy;
    $("btn-save").disabled = lock || !sig || !sig.isSigned() || blocked();
    $("profile-hint").hidden = !state.profileLoaded || state.profileOk;
    var pending = (state.editing < 0 && L.expenseRowPending(readEntry()))
      || (inv.editing < 0 && L.invoiceRowPending(readInvoice()));
    $("entry-note").hidden = !pending;
  }

  // ---- generate, fallback folder and Outlook draft ----
  function resetSave() {
    $("save-fallback").hidden = true;
    $("save-main").hidden = false;
    $("save-done").hidden = true;
    $("draft-hint").className = "hint";
    $("draft-hint").textContent = "Opens an Outlook draft with the subject and the text (nothing is sent).";
  }
  async function save(fallback) {
    $("save-fallback").hidden = true;
    var body = L.toExpensesPayload(state);
    if (fallback) body.fallback = true;
    var r = await api("POST", "/api/expenses/save", body);
    if (r.data && r.data.cancelled) return; // web edition: the user closed the "Save as" dialog; Generate PDF stays available
    if (r.ok) {
      rowErrors = { e: {}, i: {} };
      renderExpensesOnly();
      $("saved-path").textContent = r.data.path;
      $("save-main").hidden = true; $("save-done").hidden = false;
      return;
    }
    showServerError(errText(r.data, "Could not generate the PDF (error " + r.status + ")."));
    if (r.status === 507 && r.data && r.data.fallback_available) $("save-fallback").hidden = false;
  }
  $("btn-save").addEventListener("click", function () { guarded(function () { return save(false); }); });
  $("btn-fallback").addEventListener("click", function () { guarded(function () { return save(true); }); });
  $("btn-draft").addEventListener("click", function () {
    guarded(async function () {
      var r = await api("POST", "/api/draft", { year: state.year, month: state.month, kind: "expenses" });
      if (!r.ok) { showError(errText(r.data, "Could not open the draft (error " + r.status + ").")); return; }
      var hint = $("draft-hint");
      hint.className = "hint ok";
      hint.textContent = r.data.clipboard
        ? "Draft opened. The PDF is copied: press Ctrl+V in the draft to attach it."
        : "Draft opened, but the PDF could not be copied. Attach it from the folder that opened.";
    });
  });

  // ---- profile (Expenses uses only the name) ----
  function profileLoaded(p, saved) {
    state.profileLoaded = true;
    state.profileOk = !!(p && saved && L.profileIssues(p, "expenses").length === 0);
    refreshSave();
  }
  var profileOpts = {
    onLoaded: profileLoaded,
    onProfileSaved: function (p) { profileLoaded(p, true); resetSave(); schedulePreview(); }
  };
  $("btn-profile").addEventListener("click", function () {
    if (!state.dead) C.ProfileDialog.open("expenses", profileOpts);
  });

  // ---- start ----
  sig = C.SignatureCard({
    api: api, guarded: guarded, showError: showError, onChange: refreshSave,
    isBlocked: function () { return state.busy || state.dead; },
    onSigned: function () { return loadPreview(); }
  });
  initPeriod();
  setProject(false);
  clearEntry(false);
  clearInvoiceEntry(false);
  renderExpensesOnly();
  fitPreview();
  schedulePreview(); // the empty template is shown right away
  sig.show(false);
  C.startHeartbeat(function () {
    state.dead = true;
    $("closed-banner").hidden = false;
    lockControls();
    fitPreview();
  });
  C.ProfileDialog.check("expenses", profileOpts);
  guarded(function () { return sig.check(); });
})();
