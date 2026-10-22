(function () {
  "use strict";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var L = window.PerDiemLogic, C = window.PerDiemCommon, api = C.api, errText = C.errText;
  var MAX_TRIPS = L.MAX_TRIPS;
  var state = { year: 0, month: 0, trips: [], busy: false, busyPreview: false, dead: false,
    fallback: false, rateCents: null, choices: {}, profileLoaded: false, profileOk: false };
  var previewSeq = 0, previewTimer = null, keySeq = 0;
  var $ = function (id) { return document.getElementById(id); };
  var MSG_PROJECT = "Enter the project name.", MSG_PROJECT_BAD = "Use only letters, numbers and single spaces.";

  function showError(msg) {
    var box = $("error-box");
    box.textContent = msg || "";
    box.hidden = !msg;
  }
  // A background preview must not freeze typing: text inputs and the No/Yes toggles stay enabled then.
  function refreshButtons() {
    // Light (preview) requests lock nothing: only heavy operations (save, signature, draft) do.
    var lock = state.dead || heavyBusy();
    Array.prototype.forEach.call(document.querySelectorAll("button, select, input.fld"), function (x) {
      if (x.closest(".profile-dialog")) return; // the dialog manages its own controls
      x.disabled = lock;
    });
    $("btn-add-trip").disabled = lock || state.trips.length >= MAX_TRIPS;
    Array.prototype.forEach.call(document.querySelectorAll(".t-rm"), function (x) {
      x.disabled = lock || state.trips.length <= 1; // never below one trip
    });
    $("btn-save").disabled = lock || !sig.isSigned() || blocked();
    $("profile-hint").hidden = !state.profileLoaded || state.profileOk;
  }
  function heavyBusy() { return state.busy && !state.busyPreview; }
  function setBusy(b, light) { state.busy = b; state.busyPreview = !!(b && light); refreshButtons(); }

  var busyToken = 0;
  // A heavy operation may start while a light preview is in flight: it invalidates that preview
  // (its response is dropped via previewSeq) and takes over the lock (the token keeps the old finally from unlocking).
  async function guarded(fn, light) {
    if (state.dead || (state.busy && (light || !state.busyPreview))) return;
    if (state.busy) previewSeq++;
    showError("");
    var token = ++busyToken;
    setBusy(true, light);
    try { await fn(); }
    catch (e) { showError("Unexpected error: " + (e && e.message ? e.message : e)); }
    finally { if (token === busyToken) setBusy(false); }
  }
  function payload() { return L.toPayload(state.year, state.month, state.trips, state.choices); }
  function tripsBad() { return L.tripsIssues(state.trips, state.year, state.month).length > 0; }
  // Generate PDF needs: valid trips (1 to 10), every project named, a saved valid profile and a signature.
  function blocked() {
    return L.hasProjectGap(state.trips, state.choices) || tripsBad() || !state.profileOk;
  }

  // ---- preview: a fluid, screen-only layout of the same document (only the generated PDF is A4) ----
  var pv = C.PreviewFit({ area: "preview-area", scaler: "preview-scaler", clip: "preview-clip", frame: "preview-frame" });
  var fitPreview = pv.fit;

  async function loadPreview() {
    var seq = ++previewSeq;
    // The template is always shown: incomplete or invalid trips go as a lenient "draft" (never validated or saved).
    var draft = tripsBad(), body = payload();
    if (draft) body.draft = true;
    $("preview-note").hidden = !draft;
    var r = await api("POST", "/api/preview", body, true);
    if (seq !== previewSeq) return true; // stale response
    if (!r.ok) { showError(errText(r.data, "Could not generate the preview (error " + r.status + ").")); return false; }
    pv.show(r.data);
    return true;
  }

  // Each trip is a card: line 1 = number, Location, Km, value, remove; line 2 = start and end dates and the
  // day count; line 3 = project. Typing updates state, hints and totals in place (inputs are never rebuilt
  // while editing); adding or removing a trip rebuilds the list.
  var rows = [];
  function newTrip() {
    var d = L.defaultTripDates(state.year, state.month, state.trips);
    return { key: ++keySeq, start: d.start, end: d.end, location: "", km: "", touched: false };
  }
  function renderSummary() {
    var ul = $("trip-summary");
    ul.textContent = "";
    rows = [];
    state.trips.forEach(function (t, i) {
      var li = document.createElement("li");
      var el = function (tag, cls, text) {
        var e = document.createElement(tag); e.className = cls;
        if (text !== undefined) e.textContent = text;
        li.appendChild(e); return e;
      };
      var n = i + 1;
      el("span", "t-num", String(n));
      var loc = el("input", "fld t-loc"); loc.type = "text"; loc.maxLength = 30; loc.autocomplete = "off";
      loc.value = t.location; loc.setAttribute("aria-label", "Location of trip " + n); loc.title = t.location;
      loc.placeholder = "Location";
      var km = el("input", "fld t-km"); km.type = "text"; km.setAttribute("inputmode", "decimal");
      km.maxLength = 10; km.autocomplete = "off"; km.value = L.kmDisplay(t.km);
      km.setAttribute("aria-label", "Km of trip " + n); km.placeholder = "Km";
      var val = el("span", "t-val");
      var rm = el("button", "link t-rm", "✕"); rm.type = "button";
      rm.setAttribute("aria-label", "Remove trip " + n); rm.title = "Remove trip";
      var dates = el("span", "t-dates");
      var dateInput = function (cls, label, value) {
        var d = document.createElement("input"); d.type = "date"; d.className = "fld " + cls; d.value = value;
        d.min = monthStart(); d.max = monthEnd(); d.setAttribute("aria-label", label + " of trip " + n);
        dates.appendChild(d); return d;
      };
      var sd = dateInput("t-start", "Start date", t.start);
      var arrow = document.createElement("span"); arrow.textContent = "→"; dates.appendChild(arrow);
      var ed = dateInput("t-end", "End date", t.end);
      var dayCount = document.createElement("span"); dayCount.className = "t-days"; dates.appendChild(dayCount);
      tripProjectControls(t, li);
      var hint = el("span", "t-hint hint-bad");
      hint.setAttribute("aria-live", "polite");
      rows.push({ t: t, loc: loc, km: km, val: val, hint: hint, sd: sd, ed: ed, days: dayCount });
      sd.addEventListener("input", function () { t.start = sd.value; tripEdited(t); });
      ed.addEventListener("input", function () { t.end = ed.value; tripEdited(t); });
      loc.addEventListener("input", function () { t.location = loc.value; loc.title = loc.value; tripEdited(t); });
      km.addEventListener("input", function () { t.km = km.value; tripEdited(t); });
      rm.addEventListener("click", function () { if (!state.dead) removeTrip(t); });
      ul.appendChild(li);
    });
    refreshTrips();
  }
  // Inline hints (one compact line; shown once a trip was touched), computed values and the total line.
  function refreshTrips() {
    var pairs = L.overlapPairs(state.trips);
    rows.forEach(function (r, i) {
      var issues = L.tripIssues(r.t, state.year, state.month);
      pairs.forEach(function (pr) { if (pr[1] === i) issues.push(L.msgOverlap(pr[0], pr[1])); });
      var ch = state.choices[r.t.key], pi = ch && ch.on ? L.projectIssue(ch.name) : null;
      if (pi) issues.push(pi === "invalid" ? MSG_PROJECT_BAD : MSG_PROJECT);
      var shown = r.t.touched ? issues : [];
      r.hint.textContent = shown.join(" ");
      r.hint.title = shown.join(" ");
      r.hint.hidden = !shown.length;
      var nd = L.daysBetween(r.t.start, r.t.end);
      r.days.textContent = nd !== null && nd > 0 ? nd + (nd === 1 ? " day" : " days") : "";
      var dateBad = L.dateIssues(r.t, state.year, state.month).length > 0
        || pairs.some(function (pr) { return pr[0] === i || pr[1] === i; });
      r.sd.classList.toggle("invalid", r.t.touched && dateBad); r.ed.classList.toggle("invalid", r.t.touched && dateBad);
      r.loc.classList.toggle("invalid", r.t.touched && !L.locationOk(r.t.location));
      r.km.classList.toggle("invalid", r.t.touched && !L.parseKm(r.t.km).ok);
      var c = L.tripValueCents(r.t.km, state.rateCents);
      r.val.textContent = c === null ? "" : "= " + L.formatCents(c) + " €";
    });
    var tot = $("trip-total");
    tot.textContent = "";
    var sum = L.tripsTotals(state.trips, state.rateCents);
    var kmOnly = sum || L.tripsTotals(state.trips, 0);
    if (kmOnly) {
      var a = document.createElement("span"); a.textContent = "Total";
      var b = document.createElement("span");
      b.textContent = comma(kmOnly.km) + " km" + (sum ? " · " + L.formatCents(sum.cents) + " €" : "");
      tot.appendChild(a); tot.appendChild(b);
    }
  }
  function tripEdited(t) { t.touched = true; refreshTrips(); edited(); }
  function makeSeg(on, onPick) {
    var seg = document.createElement("span"); seg.className = "seg"; seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Project");
    var btns = [false, true].map(function (val) {
      var b = document.createElement("button"); b.type = "button"; b.className = "seg-btn";
      b.textContent = val ? "Yes" : "No";
      b.addEventListener("click", function () { if (!state.dead) onPick(val); });
      seg.appendChild(b); return b;
    });
    seg.set = function (v) {
      btns[0].classList.toggle("on", !v); btns[1].classList.toggle("on", v);
      btns[0].setAttribute("aria-pressed", String(!v)); btns[1].setAttribute("aria-pressed", String(v));
    };
    seg.set(on);
    return seg;
  }
  // The "Project: No/Yes" row of a trip (the name field appears only for Yes).
  function tripProjectControls(t, li) {
    var ch = state.choices[t.key] || (state.choices[t.key] = { on: false, name: "" });
    var line = document.createElement("div"); line.className = "t-projrow";
    var lab = document.createElement("span"); lab.textContent = "Project";
    var inp = document.createElement("input"); inp.type = "text"; inp.className = "fld"; inp.maxLength = 20;
    inp.placeholder = "Project name"; inp.setAttribute("aria-label", "Project name for trip " + (state.trips.indexOf(t) + 1));
    inp.autocomplete = "off"; inp.value = ch.name;
    // The project's message goes to the trip's hint line (never squeezing the name field).
    var seg = makeSeg(ch.on, function (v) { ch.on = v; t.touched = v || t.touched; sync(); refreshTrips(); edited(); if (v) inp.focus(); });
    function sync() {
      seg.set(ch.on);
      inp.hidden = !ch.on;
      var issue = ch.on ? L.projectIssue(ch.name) : null;
      inp.classList.toggle("invalid", !!issue && t.touched);
    }
    inp.addEventListener("input", function () { ch.name = inp.value; t.touched = true; sync(); refreshTrips(); edited(); });
    line.appendChild(lab); line.appendChild(seg);
    li.appendChild(line);
    inp.className = "fld t-projname"; // the name sits on its own full-width line under the toggle (only for Yes)
    li.appendChild(inp);
    sync();
  }
  function comma(v) { return String(v).replace(".", ","); }
  function monthStart() { return state.year + "-" + (state.month < 10 ? "0" : "") + state.month + "-01"; }
  function monthEnd() {
    var last = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
    return state.year + "-" + (state.month < 10 ? "0" : "") + state.month + "-" + (last < 10 ? "0" : "") + last;
  }

  function addTrip() {
    if (state.dead || state.trips.length >= MAX_TRIPS) return;
    state.trips.push(newTrip());
    renderSummary();
    edited();
    var last = rows[rows.length - 1];
    if (last) { last.loc.focus(); if (last.loc.scrollIntoView) last.loc.scrollIntoView({ block: "nearest" }); }
  }
  function removeTrip(t) {
    if (state.trips.length <= 1) return;
    state.trips.splice(state.trips.indexOf(t), 1);
    delete state.choices[t.key];
    renderSummary();
    edited();
  }
  $("btn-add-trip").addEventListener("click", addTrip);

  // ---- month ----
  function resetSave() {
    state.fallback = false;
    $("save-fallback").hidden = true;
    $("save-main").hidden = false;
    $("save-done").hidden = true;
    $("draft-hint").className = "hint";
    $("draft-hint").textContent = "Opens an Outlook draft with the subject and the text (nothing is sent).";
  }
  // A new period starts with ONE empty trip (dates inside the month, location and km to fill in).
  function resetTrips() {
    state.month = parseInt($("month-select").value, 10);
    state.year = parseInt($("year-select").value, 10);
    state.trips = []; state.choices = {};
    state.trips.push(newTrip());
    renderSummary();
    resetSave(); // a PDF/draft button from another month must not stay visible
    edited();
  }
  function initMonth() {
    var ms = $("month-select"), ys = $("year-select"), now = new Date(), o;
    MONTHS.forEach(function (m, i) {
      o = document.createElement("option"); o.value = String(i + 1); o.textContent = m; ms.appendChild(o);
    });
    for (var y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
      o = document.createElement("option"); o.value = String(y); o.textContent = String(y); ys.appendChild(o);
    }
    ms.value = String(now.getMonth() + 1);
    ys.value = String(now.getFullYear());
  }
  function onPeriodChange() {
    if (heavyBusy() || state.dead) return;
    resetTrips();
  }
  $("month-select").addEventListener("change", onPeriodChange);
  $("year-select").addEventListener("change", onPeriodChange);

  // ---- preview scheduling / edits ----
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 500);
  }
  function runPreview() {
    previewTimer = null;
    if (state.dead) return;
    if (state.busy) { previewTimer = setTimeout(runPreview, 250); return; }
    guarded(loadPreview, true);
  }
  // Any edit of a trip (location, km, dates, project, count): unlock a saved state, refresh the gate and the preview.
  function edited() {
    resetSave();
    refreshButtons();
    schedulePreview();
  }
  // ---- signature ----
  var sig = C.SignatureCard({
    api: api, guarded: guarded, showError: showError, onChange: refreshButtons,
    isBlocked: function () { return heavyBusy() || state.dead; },
    onSigned: function () { return loadPreview(); }
  });

  // ---- save ----
  async function save(fallback) {
    state.fallback = !!fallback; // a normal save never uses the alternative folder
    $("save-fallback").hidden = true;
    var body = payload();
    if (fallback) body.fallback = true;
    var r = await api("POST", "/api/save", body);
    if (r.ok) {
      $("saved-path").textContent = r.data.path;
      $("save-main").hidden = true; $("save-done").hidden = false;
      return;
    }
    if (r.data && r.data.cancelled) return; // web edition: the user closed the "Save as" dialog; Generate PDF stays available
    showError(errText(r.data, "Could not generate the PDF (error " + r.status + ")."));
    if (r.status === 507 && r.data && r.data.fallback_available) $("save-fallback").hidden = false;
  }
  $("btn-save").addEventListener("click", function () { guarded(function () { return save(false); }); });
  $("btn-fallback").addEventListener("click", function () { guarded(function () { return save(true); }); });
  $("btn-draft").addEventListener("click", function () {
    guarded(async function () {
      var r = await api("POST", "/api/draft", { year: state.year, month: state.month, kind: "perdiem" });
      if (!r.ok) { showError(errText(r.data, "Could not open the draft (error " + r.status + ").")); return; }
      var hint = $("draft-hint");
      hint.className = "hint ok";
      hint.textContent = r.data.clipboard
        ? "Draft opened. The PDF is copied: press Ctrl+V in the draft to attach it."
        : "Draft opened, but the PDF could not be copied. Attach it from the folder that opened.";
    });
  });
  $("btn-another").addEventListener("click", function () { if (!heavyBusy() && !state.dead) resetTrips(); });

  // ---- profile ----
  function profileLoaded(p, saved) {
    state.profileLoaded = true;
    state.profileOk = !!(p && saved && L.profileIssues(p, "perdiem").length === 0);
    refreshButtons();
  }
  var profileOpts = {
    onLoaded: profileLoaded,
    onProfileSaved: function (p) {
      profileLoaded(p, true);
      resetSave();
      schedulePreview(); // the preview shows the new name
    }
  };
  $("btn-profile").addEventListener("click", function () { if (!state.dead) C.ProfileDialog.open("perdiem", profileOpts); });

  // ---- start ----
  initMonth();
  fitPreview();
  sig.show(false);
  C.startHeartbeat(function () {
    state.dead = true;
    $("closed-banner").hidden = false;
    refreshButtons();
    fitPreview();
  });
  C.ProfileDialog.check("perdiem", profileOpts);
  guarded(async function () {
    await sig.check();
    var r = await api("GET", "/api/settings");
    if (!r.ok) { showError(errText(r.data, "Could not load the settings (error " + r.status + ").")); }
    else state.rateCents = L.rateToCents(r.data.rate);
    resetTrips();
    refreshButtons();
  });
})();
