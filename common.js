// Shared by the report pages: API helper, heartbeat and the signature card.
(function () {
  "use strict";
  var PAD_W = 360, PAD_H = 100;
  var MSG_DRAW = "Draw your signature first";

  function errText(data, fallback) {
    var e = data && data.error;
    if (Array.isArray(e)) return e.join("\n");
    if (typeof e === "string" && e) return e;
    return fallback;
  }

  // Optional replacement for fetch (the web edition runs the engine in the browser):
  // fn(method, path, body, asText) -> Promise<{ok, status, data}>.
  var transport = null;
  function setTransport(fn) { transport = fn || null; }

  // Resolves to {ok, status, data}; never throws (network failure -> status 0 with a message).
  async function api(method, path, body, asText) {
    if (transport) {
      try { return await transport(method, path, body, asText); }
      catch (e) { return { ok: false, status: 0, data: { error: String((e && e.message) || e) } }; }
    }
    try {
      var opts = { method: method };
      if (body !== undefined) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
      }
      var r = await fetch(path, opts);
      var data;
      if (asText && r.ok) data = await r.text();
      else { try { data = await r.json(); } catch (e) { data = {}; } }
      return { ok: r.ok, status: r.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: "No connection to the local server. Check that the application is running." } };
    }
  }

  // Keeps the local app alive while the page is open and tells it when the page goes away.
  // onDead() runs once if a ping cannot reach the server (the timer then stops).
  function startHeartbeat(onDead) {
    if (transport) return { stop: function () {} }; // no server to keep alive
    var timer = null, dead = false;
    // Each page identifies itself, so the server can tell a stale bye (from the page we navigated
    // away from) from the close of the page that is pinging.
    var pageId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    async function ping() {
      var r = await api("POST", "/api/ping", { page: pageId });
      if (r.status === 0 && !dead) {
        dead = true;
        if (timer) clearInterval(timer);
        if (onDead) onDead();
      }
    }
    window.addEventListener("pagehide", function () {
      try { navigator.sendBeacon("/api/bye", new Blob([JSON.stringify({ page: pageId })], { type: "text/plain" })); } catch (e) { /* ignore */ }
    });
    ping();
    timer = setInterval(ping, 10000);
  }

  // Uploads one proof file; resolves to {ok, status, data} and never throws.
  // The web edition replaces this with an in-browser implementation.
  async function uploadProof(file) {
    try {
      var r = await fetch("/api/expenses/proof", { method: "POST", body: file, headers: {
        "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) } });
      var data;
      try { data = await r.json(); } catch (x) { data = {}; }
      return { ok: r.ok, status: r.status, data: data };
    } catch (x) {
      return { ok: false, status: 0, data: { error: "No connection to the local server. Check that the application is running." } };
    }
  }

  // The signature drawing pad plus the saved / redraw / cancel / sign states.
  // opts: api, guarded(fn), showError(msg), onChange() after the signed state changes,
  // isBlocked() true while the page is busy or dead (redraw / cancel are then ignored),
  // onSigned() (optional) runs inside the guarded operation once the signature was saved.
  function SignatureCard(opts) {
    var $ = function (id) { return document.getElementById(id); };
    var pad = $("signature-pad"), ctx = pad.getContext("2d"), hasInk = false, drawing = false;
    var signed = false;
    var showError = opts.showError;
    function setupPad() {
      var dpr = window.devicePixelRatio || 1;
      pad.width = Math.round(PAD_W * dpr);
      pad.height = Math.round(PAD_H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#10205a";
      hasInk = false;
      pad.parentNode.classList.remove("inked");
    }
    function clearPad() {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pad.width, pad.height);
      ctx.restore();
      hasInk = false;
      pad.parentNode.classList.remove("inked");
    }
    function pos(e) {
      var r = pad.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (PAD_W / r.width), y: (e.clientY - r.top) * (PAD_H / r.height) };
    }
    pad.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      drawing = true;
      try { pad.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      if ($("error-box").textContent === MSG_DRAW) showError("");
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y); ctx.stroke(); // dot for a single tap
      hasInk = true;
      pad.parentNode.classList.add("inked"); // hides the "Sign here" hint
      e.preventDefault();
    });
    pad.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      e.preventDefault();
    });
    function stopDrawing() { drawing = false; }
    pad.addEventListener("pointerup", stopDrawing);
    pad.addEventListener("pointercancel", stopDrawing);
    pad.addEventListener("pointerleave", stopDrawing);
    $("btn-clear").addEventListener("click", function () { clearPad(); showError(""); });

    function show(saved) {
      signed = saved;
      $("sign-saved").hidden = !saved;
      $("sign-draw").hidden = saved;
      $("btn-cancel-redraw").hidden = true;
      if (!saved) setupPad();
      opts.onChange();
    }
    async function check() {
      var r = await opts.api("GET", "/api/signature");
      if (!r.ok) { showError(errText(r.data, "Could not check the signature (error " + r.status + ").")); return; }
      show(!!r.data.signed);
    }
    $("btn-redraw").addEventListener("click", function () {
      if (!opts.isBlocked()) { showError(""); show(false); $("btn-cancel-redraw").hidden = false; }
    });
    $("btn-cancel-redraw").addEventListener("click", function () {
      if (!opts.isBlocked()) { showError(""); show(true); }
    });
    $("btn-sign").addEventListener("click", function () {
      opts.guarded(async function () {
        if (!hasInk) { showError(MSG_DRAW); return; }
        var r = await opts.api("POST", "/api/signature", { png_base64: pad.toDataURL("image/png") });
        if (!r.ok) { showError(errText(r.data, "Could not save the signature (error " + r.status + ").")); return; }
        show(true);
        if (opts.onSigned) await opts.onSigned();
      });
    });

    // ---- upload an image: convert (white -> transparent, <= 800x300), preview, then save like a drawing ----
    var L = window.PerDiemLogic, pendingPng = null;
    function setPreview(png) {
      pendingPng = png;
      $("sig-preview").hidden = !png;
      $("sign-draw").hidden = !!png; // a preview only exists while in drawing mode
      if (png) { $("sig-preview-img").src = png; $("btn-use-upload").focus(); }
      else { $("sig-preview-img").removeAttribute("src"); $("btn-upload").focus(); }
    }
    async function decode(file) {
      if (window.createImageBitmap) {
        try { return { img: await createImageBitmap(file, { imageOrientation: "from-image" }), done: function () {} }; }
        catch (e) { /* fall back to <img> */ }
      }
      var url = URL.createObjectURL(file);
      var done = function () { URL.revokeObjectURL(url); };
      try {
        var img = new Image();
        await new Promise(function (ok, bad) { img.onload = ok; img.onerror = bad; img.src = url; });
        return { img: img, done: done };
      } catch (e) { done(); throw e; }
    }
    var MSG_DETAIL = "The image is too detailed. Try a cleaner picture of the signature.";
    // Returns a PNG data URL, null when blank, or "" when too large even after halving the size.
    async function convert(file) {
      var d = await decode(file);
      try {
        var iw = d.img.naturalWidth || d.img.width, ih = d.img.naturalHeight || d.img.height;
        if (!iw || !ih) throw new Error("empty");
        var limits = [[800, 300], [400, 150]];
        for (var k = 0; k < limits.length; k++) {
          var s = L.fitSize(iw, ih, limits[k][0], limits[k][1]);
          var c = document.createElement("canvas");
          c.width = s.w; c.height = s.h;
          var cx = c.getContext("2d");
          cx.imageSmoothingQuality = "high";
          cx.drawImage(d.img, 0, 0, s.w, s.h);
          var data = cx.getImageData(0, 0, s.w, s.h);
          data = new ImageData(L.inkToAlpha(data.data), s.w, s.h);
          if (L.countOpaque(data.data) < 20) return null;
          cx.putImageData(data, 0, 0);
          var url = c.toDataURL("image/png");
          if (url.length <= 900000) return url;
        }
        return "";
      } finally { d.done(); if (d.img.close) d.img.close(); }
    }
    $("btn-upload").addEventListener("click", function () {
      if (!opts.isBlocked()) $("sig-file").click();
    });
    $("sig-file").addEventListener("change", async function () {
      var file = this.files && this.files[0];
      this.value = "";
      if (!file || opts.isBlocked()) return;
      showError("");
      var issue = L.signatureFileIssue({ size: file.size, type: file.type });
      if (issue) { showError(issue); return; }
      var png;
      try { png = await convert(file); }
      catch (e) { showError("Could not read this image."); return; }
      if (png === "") { showError(MSG_DETAIL); return; }
      if (!png) { showError("No signature found in the image (it looks blank)."); return; }
      setPreview(png);
    });
    $("btn-cancel-upload").addEventListener("click", function () {
      if (opts.isBlocked()) return;
      showError(""); setPreview(null);
    });
    $("btn-use-upload").addEventListener("click", function () {
      opts.guarded(async function () {
        if (!pendingPng) return;
        var r = await opts.api("POST", "/api/signature", { png_base64: pendingPng });
        if (!r.ok) { showError(errText(r.data, "Could not save the signature (error " + r.status + ").")); return; }
        setPreview(null);
        show(true);
        if (opts.onSigned) await opts.onSigned();
      });
    });
    return { isSigned: function () { return signed; }, show: show, check: check };
  }

  // The Profile dialog (native <dialog>): Name / Office / Plate for "perdiem", Name only for "expenses".
  // While the profile is not saved yet the dialog cannot be dismissed (no Cancel, Esc ignored).
  var FIELDS = [
    { key: "name", label: "Name", max: 60, kinds: ["perdiem", "expenses"] },
    { key: "office", label: "Office", max: 30, kinds: ["perdiem"] },
    { key: "plate", label: "Plate", max: 15, kinds: ["perdiem"] }
  ];
  var profileDlg = null;
  // Expenses needs a saved name; the Per Diem needs name, office and plate all confirmed by the user.
  function profileConfirmed(kind, data) { return kind === "expenses" ? !!data.saved : !!data.complete; }

  // opts: onProfileSaved(profile) after a successful save; onLoaded(profile, saved) after each GET.
  async function openProfile(kind, opts) {
    opts = opts || {};
    if (profileDlg) { try { profileDlg.close(); } catch (e) { /* ignore */ } profileDlg.remove(); profileDlg = null; }
    var L = window.PerDiemLogic;
    var dlg = document.createElement("dialog");
    dlg.className = "profile-dialog";
    dlg.setAttribute("aria-labelledby", "profile-title");
    var form = document.createElement("form");
    form.noValidate = true;
    var title = document.createElement("h2");
    title.id = "profile-title"; title.textContent = "Profile";
    form.appendChild(title);
    var inputs = {};
    FIELDS.forEach(function (f) {
      if (f.kinds.indexOf(kind) < 0) return;
      var lab = document.createElement("label");
      lab.appendChild(document.createTextNode(f.label));
      var inp = document.createElement("input");
      inp.type = "text"; inp.className = "fld"; inp.maxLength = f.max; inp.autocomplete = "off";
      inp.id = "profile-" + f.key; inp.disabled = true;
      lab.appendChild(inp); form.appendChild(lab);
      inputs[f.key] = inp;
    });
    var err = document.createElement("div");
    err.className = "error"; err.setAttribute("role", "alert"); err.hidden = true;
    form.appendChild(err);
    var actions = document.createElement("div");
    actions.className = "actions";
    var cancel = document.createElement("button");
    cancel.type = "button"; cancel.id = "profile-cancel"; cancel.textContent = "Cancel"; cancel.hidden = true;
    var save = document.createElement("button");
    save.type = "submit"; save.id = "profile-save"; save.className = "primary"; save.textContent = "Save";
    save.disabled = true;
    actions.appendChild(cancel); actions.appendChild(save); form.appendChild(actions);
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    profileDlg = dlg;

    var saved = false, loaded = { name: "", office: "", plate: "" }, busy = false;
    function showErr(msg) { err.textContent = msg || ""; err.hidden = !msg; }
    function closeIt() { dlg.removeAttribute("data-open"); dlg.close(); dlg.remove(); if (profileDlg === dlg) profileDlg = null; }
    dlg.addEventListener("cancel", function (e) { if (!saved) e.preventDefault(); });
    dlg.addEventListener("close", function () {
      // Some browsers close on a second Esc even when cancelled: re-open while a profile is still required.
      if (!saved && dlg.hasAttribute("data-open") && dlg.isConnected) dlg.showModal();
    });
    cancel.addEventListener("click", function () { if (saved) closeIt(); });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (busy) return;
      var p = { name: loaded.name, office: loaded.office, plate: loaded.plate };
      Object.keys(inputs).forEach(function (k) { p[k] = inputs[k].value; });
      var issues = L ? L.profileIssues(p, kind) : [];
      if (issues.length) { showErr(issues.join("\n")); return; }
      busy = true; save.disabled = true; showErr("");
      // The Expenses Report stores only the name; the Per Diem confirms Office and Plate too.
      var r = await api("POST", "/api/profile", kind === "expenses"
        ? { name: p.name, kind: "expenses" } : { name: p.name, office: p.office, plate: p.plate });
      busy = false; save.disabled = false;
      if (!r.ok) { showErr(errText(r.data, "Could not save the profile (error " + r.status + ").")); return; }
      saved = true;
      closeIt();
      if (opts.onProfileSaved) opts.onProfileSaved(p);
    });

    dlg.setAttribute("data-open", "1");
    dlg.showModal();
    var r = await api("GET", "/api/profile");
    if (!dlg.isConnected) return;
    if (r.ok) {
      loaded = { name: String(r.data.name || ""), office: String(r.data.office || ""), plate: String(r.data.plate || "") };
      saved = profileConfirmed(kind, r.data); // Office/Plate shown here may be only suggestions
      Object.keys(inputs).forEach(function (k) { inputs[k].value = loaded[k]; });
      if (opts.onLoaded) opts.onLoaded(loaded, saved);
      if (opts.confirmOnOpen) { // every page load: the saved values must be confirmed (or edited) before working
        if (saved) save.textContent = "Continue";
        saved = false; // no Cancel, Esc ignored: the page behind stays blocked until confirmed
      }
    } else {
      saved = true; // cannot tell: do not trap the user in the dialog
      showErr(errText(r.data, "Could not load the profile (error " + r.status + ")."));
    }
    cancel.hidden = !saved;
    Object.keys(inputs).forEach(function (k) { inputs[k].disabled = false; });
    save.disabled = false;
    var first = inputs.name; if (first) { first.focus(); first.select(); }
  }

  // Page start: loads the profile, reports it through onLoaded(profile, saved) and opens the
  // dialog by itself when nothing is saved yet (first use).
  async function checkProfile(kind, opts) {
    opts = opts || {};
    var r = await api("GET", "/api/profile");
    if (!r.ok) {
      if (opts.onLoaded) opts.onLoaded(null, false);
      return;
    }
    var p = { name: String(r.data.name || ""), office: String(r.data.office || ""), plate: String(r.data.plate || "") };
    var confirmed = profileConfirmed(kind, r.data);
    if (opts.onLoaded) opts.onLoaded(p, confirmed);
    // Always open on a page load, prefilled: one "Continue" (or Enter) confirms; first use is the same dialog ("Save").
    openProfile(kind, Object.assign({}, opts, { confirmOnOpen: true }));
  }
  var ProfileDialog = { open: openProfile, check: checkProfile };

  // Screen-only presentation of the report HTML: NOT an A4 sheet. The same document is laid out fluidly at a width
  // chosen from the area (so it reads like a wide card that fills the area); only a long document scrolls.
  // The PDF is untouched: this style is injected on the page only.
  var SCREEN_STYLE = "<style>html{padding:22px 32px 18px;overflow:hidden;}.page{min-height:0 !important;}.ft{margin-top:14px;}</style>";
  var TARGET_SCALE = 0.9, MIN_SCALE = 0.6;
  function PreviewFit(ids) {
    var $ = function (id) { return document.getElementById(id); };
    var area = $(ids.area), scaler = $(ids.scaler), clip = $(ids.clip), frame = $(ids.frame);
    function fit() {
      var aw = area.clientWidth - 56, ah = area.clientHeight - 64;
      if (aw <= 0 || ah <= 0) return;
      var layoutW = Math.max(600, Math.round(aw / TARGET_SCALE));
      frame.style.width = clip.style.width = layoutW + "px";
      frame.style.height = "10px"; // so scrollHeight is the content height, not the previous frame height
      var h = 700;
      try { h = Math.max(200, frame.contentDocument.documentElement.scrollHeight); } catch (e) { /* cross-origin: keep default */ }
      var s = Math.max(Math.min(aw / layoutW, ah / h), MIN_SCALE);
      frame.style.height = clip.style.height = h + "px";
      clip.style.transform = "scale(" + s + ")";
      scaler.style.width = Math.floor(layoutW * s) + "px";
      scaler.style.height = Math.floor(h * s) + "px";
      area.classList.toggle("scroll", h * s > ah + 1); // only a long document scrolls
    }
    frame.addEventListener("load", fit);
    window.addEventListener("resize", fit);
    return {
      fit: fit,
      show: function (html) { frame.srcdoc = String(html).replace("</head>", SCREEN_STYLE + "</head>"); }
    };
  }

  var common = { api: api, setTransport: setTransport, proofUpload: uploadProof, errText: errText, startHeartbeat: startHeartbeat, SignatureCard: SignatureCard,
    ProfileDialog: ProfileDialog, PreviewFit: PreviewFit };
  if (typeof window !== "undefined") window.PerDiemCommon = common;
  if (typeof module !== "undefined" && module.exports) module.exports = common;
})();
