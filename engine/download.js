// Hands the generated PDF to the user. savePdf(base64, filename, env) -> Promise<{saved, cancelled}>:
//  - with showSaveFilePicker (Chromium) in a top-level page: the native "Save as" dialog; closing it
//    (AbortError) is a cancellation, not an error, and the user can simply click Generate again;
//  - otherwise (or when the picker is blocked: no user activation left, iframe, policy): an <a download>.
// env is injectable for tests: {window, document, URL, Blob, setTimeout}; it defaults to the globals.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.PerDiemEngine = root.PerDiemEngine || {}).download = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function defaultEnv() {
    var g = typeof self !== "undefined" ? self : globalThis;
    return { window: g, document: g.document, URL: g.URL, Blob: g.Blob, setTimeout: g.setTimeout.bind(g) };
  }

  function decode(base64, env) {
    var bin = (env.window.atob || atob)(base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function isTopLevel(win) {
    try { return win.top === win; } catch (e) { return false; }
  }

  function viaAnchor(blob, filename, env) {
    var url = env.URL.createObjectURL(blob);
    var a = env.document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    env.document.body.appendChild(a);
    a.click();
    env.setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      env.URL.revokeObjectURL(url);
    }, 10000);
  }

  async function savePdf(base64, filename, env) {
    env = env || defaultEnv();
    var blob = new env.Blob([decode(base64, env)], { type: "application/pdf" });
    var picker = env.window.showSaveFilePicker;
    if (typeof picker === "function" && isTopLevel(env.window)) {
      try {
        var handle = await picker.call(env.window, {
          suggestedName: filename,
          types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }]
        });
        var w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return { saved: true, cancelled: false };
      } catch (e) {
        if (e && e.name === "AbortError") return { saved: false, cancelled: true };
        // blocked (SecurityError / NotAllowedError) or not writable: fall back to a normal download
      }
    }
    viaAnchor(blob, filename, env);
    return { saved: true, cancelled: false };
  }

  return { savePdf: savePdf };
});
