(function () {
  "use strict";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var MAX_CENTS = 9999999;
  var L = window.PerDiemLogic, C = window.PerDiemCommon, api = C.api, errText = C.errText;
  var $ = function (id) { return document.getElementById(id); };
  var state = { year: 0, month: 0, expenses: [], editing: -1, dead: false,
    busy: false, profileLoaded: false, profileOk: false };
  var sig = null; // the shared Signature card, created at start
  var previewSeq = 0, previewTimer = null, touched = false;
  // Server messages that start with "Expense N:" / "Expense N, proof K:" are shown under that row.
  var rowErrors = {};
  var projectOn = false;

  var errSource = ""; // who raised the visible error ("preview" errors are cleared by a good preview)
  function showError(msg, src) {
    var box = $("error-box");
    box.textContent = msg || "";
    box.hidden = !msg;
    errSource = msg ? (src || "") : "";
  }
  function changed() { rowErrors = {}; resetSave(); render(); schedulePreview(); }
  // "Expense N: ..." lines go under their row; the rest stays in the error box.
  function showServerError(text, src) {
    var rest = [];
    rowErrors = {};
    String(text).split("\n").forEach(function (line) {
      var m = /^Expense (\d+)(?:, proof \d+)?: (.*)$/.exec(line);
      if (m) (rowErrors[m[1]] = rowErrors[m[1]] || []).push(m[2]);
      else rest.push(line);
    });
    render();
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
  // The proofs of the entry being typed/edited live in entry.proofs (already uploaded: the server owns them).
  var entry = { proofs: [], uploading: false, errors: [] };
  var uploadSeq = 0;
  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function filesText(n) { return n + (n === 1 ? " file" : " files"); }
  function readEntry() {
    return { date: $("entry-date").value, location: $("entry-location").value, description: $("entry-description").value,
      projectOn: projectOn, project: $("entry-project-name").value, amount: $("entry-amount").value, proofs: entry.proofs };
  }
  function writeEntry(e) {
    $("entry-location").value = e.location || "";
    $("entry-date").value = e.date; $("entry-description").value = e.description;
    $("entry-amount").value = e.amount; setProject(e.projectOn);
    $("entry-project-name").value = e.projectOn ? e.project : "";
    entry.proofs = (e.proofs || []).slice(); entry.errors = []; entry.uploading = false; uploadSeq++;
    renderEntryProofs();
  }
  function entryChanged() {
    touched = true;
    refreshEntry();
  }
  function refreshEntry() {
    var e = readEntry(), issues = L.expenseIssues(e);
    $("btn-add-entry").disabled = state.dead || state.busy || entry.uploading || issues.length > 0;
    $("entry-hint").textContent = touched && issues.length ? issues[0] : "";
    $("entry-location").classList.toggle("invalid", touched && !L.locationOk(e.location));
    $("entry-date").classList.toggle("invalid", touched && !L.isoDateOk(e.date));
    $("entry-amount").classList.toggle("invalid", touched && L.parseAmount(e.amount, MAX_CENTS) === null);
    $("btn-cancel-entry").hidden = state.editing < 0;
    $("btn-attach-proof").disabled = state.dead || state.busy || entry.uploading;
    Array.prototype.forEach.call($("entry-proofs").querySelectorAll("button"), function (b) {
      b.disabled = state.dead || state.busy || entry.uploading;
    });
    $("entry-proof-hint").textContent = entry.uploading ? "Uploading…" : "JPG, PNG or PDF, up to 8 MB each";
    refreshSave();
  }
  function clearEntry(keepDate) {
    var d = keepDate ? $("entry-date").value : todayIso();
    writeEntry({ date: d, location: "", description: "", projectOn: false, project: "", amount: "", proofs: [] });
    touched = false;
    refreshEntry();
  }
  function renderEntryProofs() {
    var ul = $("entry-proofs");
    ul.textContent = "";
    entry.proofs.forEach(function (p, i) {
      var li = document.createElement("li");
      var nm = document.createElement("span"); nm.className = "p-name"; nm.textContent = p.name; nm.title = p.name;
      var sz = document.createElement("span"); sz.className = "p-size";
      sz.textContent = fmtSize(p.size) + (p.kind === "pdf" && p.pages ? " · " + p.pages + (p.pages === 1 ? " page" : " pages") : "");
      var b = document.createElement("button"); b.type = "button"; b.className = "link"; b.textContent = "Remove";
      b.setAttribute("aria-label", "Remove proof " + p.name);
      b.addEventListener("click", function () {
        if (state.dead || state.busy || entry.uploading) return;
        entry.proofs.splice(i, 1); entry.errors = [];
        renderEntryProofs(); entryChanged();
      });
      li.appendChild(nm); li.appendChild(sz); li.appendChild(b);
      ul.appendChild(li);
    });
    var eb = $("entry-proof-errors");
    eb.textContent = "";
    entry.errors.forEach(function (m) {
      var d = document.createElement("div"); d.textContent = m; eb.appendChild(d);
    });
  }

  // ---- the list ----
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
      var sub = document.createElement("span"); sub.className = "x-sub"; li.appendChild(sub);
      var part = function (cls, text) {
        var x = document.createElement("span"); x.className = cls; x.textContent = text; x.title = text; sub.appendChild(x);
      };
      part("x-loc", e.location);
      var np = (e.proofs || []).length;
      if (np) part("x-files", filesText(np));
      if (e.projectOn) part("x-proj", "Project: " + e.project);
      (rowErrors[i + 1] || []).forEach(function (m) { el("x-err", m); });
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
    if (state.dead || entry.uploading || !L.isExpenseEntryComplete(e)) return;
    var item = { date: e.date, location: e.location.trim(), description: e.description.trim(), projectOn: e.projectOn,
      project: e.projectOn ? e.project.trim() : "", amount: e.amount.trim(), proofs: entry.proofs.slice() };
    if (state.editing >= 0) state.expenses[state.editing] = item;
    else state.expenses.push(item);
    stopEdit();
    clearEntry(true);
    changed();
    $("entry-location").focus();
  }
  $("btn-add-entry").addEventListener("click", commitEntry);
  $("btn-cancel-entry").addEventListener("click", function () { stopEdit(); clearEntry(true); render(); });
  ["entry-location", "entry-date", "entry-description", "entry-amount", "entry-project-name"].forEach(function (id) {
    $(id).addEventListener("input", entryChanged);
    $(id).addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitEntry(); }
    });
  });

  // ---- proofs of the entry: several files, each uploaded at once (the server owns name/kind/pages) ----
  async function uploadFiles(files) {
    if (entry.uploading || state.busy || state.dead || !files.length) return;
    var seq = ++uploadSeq;
    entry.uploading = true; entry.errors = [];
    renderEntryProofs(); refreshEntry();
    for (var k = 0; k < files.length; k++) {
      var file = files[k], fail = null;
      var sizes = L.proofSizes(state.expenses, state.editing).concat(entry.proofs.map(function (p) { return p.size; }));
      var issue = L.proofBudgetIssue(sizes, file.size);
      if (issue) fail = issue;
      else {
        try { encodeURIComponent(file.name); } catch (x) { fail = "The file name is not valid."; }
      }
      if (!fail) {
        var res = await C.proofUpload(file);
        if (seq !== uploadSeq) return; // the entry was cleared or edited meanwhile
        if (res.ok) {
          var r = L.proofFromUpload(res.data);
          if (r.proof) entry.proofs.push(r.proof); else fail = r.error;
        } else fail = errText(res.data, "Could not upload the file (error " + res.status + ").");
      }
      if (fail) entry.errors.push(file.name + ": " + fail);
      renderEntryProofs();
    }
    entry.uploading = false;
    refreshEntry();
  }
  $("btn-attach-proof").addEventListener("click", function () { if (!state.dead) $("entry-file").click(); });
  $("entry-file").addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files || []);
    try { this.value = ""; } catch (x) { /* read-only in some test doubles */ }
    if (files.length && !state.dead && !state.busy && !entry.uploading) uploadFiles(files);
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
    if (!lock) refreshEntry();
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
  // Generate PDF needs: a signature, a valid Name, at least one expense, no row being edited, no upload running.
  function blocked() {
    return !state.expenses.length || state.editing >= 0 || entry.uploading || !state.profileOk;
  }
  function refreshSave() {
    var lock = state.dead || state.busy;
    $("btn-save").disabled = lock || !sig || !sig.isSigned() || blocked();
    $("profile-hint").hidden = !state.profileLoaded || state.profileOk;
    var pending = state.editing < 0 && L.expenseRowPending(readEntry());
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
      rowErrors = {};
      render();
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
  render();
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
