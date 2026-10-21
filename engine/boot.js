// Wires the shared pages (copied from perdiem/static) to the in-browser engine. Loaded after
// common.js and before the page's own script, so the transport is set before anything calls api()
// or startHeartbeat(). Nothing is stored anywhere: the profile and the signature live in the router.
(function () {
  "use strict";
  var C = window.PerDiemCommon, E = window.PerDiemEngine;
  var router = E.router.create({ config: E.config, logoUri: E.assets && E.assets.logoDataUri });

  // /api/save answers {pdf_base64, filename}: download it, then answer like the local app does
  // ({path}) so the unchanged page shows the saved state with the file name instead of a path.
  async function transport(method, path, body, asText) {
    var r = await router.handle(method, path, body, asText);
    if (method === "POST" && /^\/api\/(expenses\/)?save$/.test(path) && r.ok && r.data && r.data.pdf_base64) {
      var saved;
      try { saved = await E.download.savePdf(r.data.pdf_base64, r.data.filename); }
      catch (e) { return { ok: false, status: 0, data: { error: "Could not save the PDF: " + ((e && e.message) || e) } }; }
      if (saved.cancelled) return { ok: false, status: 0, data: { cancelled: true } };
      return { ok: true, status: 200, data: { path: r.data.filename } };
    }
    return r;
  }
  C.setTransport(transport);

  // Proof upload (Expenses): the file's bytes go to the router's POST /api/expenses/proof (the
  // in-memory proof store), answered like the local server: {ok, status, data: {id, name, kind,
  // size, pages}} or {ok: false, status: 413/422, data: {error}}.
  function readBytes(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }
  C.proofUpload = async function (file) {
    var bytes;
    try { bytes = new Uint8Array(await readBytes(file)); }
    catch (e) { return { ok: false, status: 0, data: { error: "Could not read the file." } }; }
    return router.handle("POST", "/api/expenses/proof", { name: file.name, bytes: bytes });
  };

  // Differences from the local app that live in the DOM (the page files are shared byte for byte):
  // no Outlook draft, and the saved state names the file instead of a folder path.
  function adaptDom() {
    var draft = document.getElementById("btn-draft");
    if (draft) { draft.hidden = true; draft.style.display = "none"; }
    var hint = document.getElementById("draft-hint");
    if (hint) { hint.hidden = true; hint.style.display = "none"; }
    var done = document.getElementById("save-done");
    var label = done && done.querySelector("p.ok");
    if (label) {
      // Inside a sandboxed frame (SharePoint) the browser may have blocked the download without telling
      // the page: do not claim success, say what to do.
      var framed = E.frameNotice && E.frameNotice.check(window).embedded;
      label.textContent = framed ? "PDF prepared. If the download did not start, open this page in its own tab:" : "\u2713 PDF generated:";
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", adaptDom);
  else adaptDom();
})();
