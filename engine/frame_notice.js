// Notice for the page running inside a frame (SharePoint shows HTML files in a sandboxed iframe:
// page URL about:srcdoc, downloads and the save dialog are blocked there).
//   frameNotice.check(win) -> {embedded: boolean}
//   frameNotice.show(win, doc) -> element|null: inserts the fixed notice at the top (once)
//   frameNotice.run(win, doc)  -> check + show; called on load in the browser
// Detection uses no storage API (the sandbox makes them throw, and this app never uses any): window.top !== window, an about: page URL, or a frameElement lookup that throws.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.frameNotice = factory();
    if (typeof root.document !== "undefined") {
      var go = function () { ns.frameNotice.run(root, root.document); };
      if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", go);
      else go();
    }
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var ID = "frame-notice";
  var TEXT_LINK = "To download the PDF, open this page in its own tab: ";
  var TEXT_NO_LINK = "To download the PDF, open this app from its link in your browser's address bar, not from inside SharePoint.";

  function href(win) {
    try { return String((win.location && win.location.href) || ""); } catch (e) { return ""; }
  }

  function check(win) {
    var embedded = false;
    try { if (win.top !== win) embedded = true; } catch (e) { embedded = true; }
    if (!embedded) {
      try { if (win.frameElement) embedded = true; } catch (e) { embedded = true; }
    }
    if (!embedded && href(win).toLowerCase().indexOf("about:") === 0 && href(win).toLowerCase() !== "about:blank") embedded = true;
    return { embedded: embedded };
  }

  function show(win, doc) {
    if (doc.getElementById && doc.getElementById(ID)) return null;
    var el = doc.createElement("div");
    el.id = ID;
    el.setAttribute("role", "status");
    var s = el.style;
    s.position = "fixed"; s.top = "0"; s.left = "0"; s.right = "0"; s.zIndex = "2147483647";
    s.background = "#fff3cd"; s.color = "#4d3b00"; s.borderBottom = "1px solid #e0c36a";
    s.padding = "8px 40px 8px 16px"; s.font = "14px/1.4 Calibri, Arial, sans-serif"; s.boxSizing = "border-box";
    var url = href(win);
    if (/^https?:\/\//i.test(url)) {
      el.appendChild(doc.createTextNode(TEXT_LINK));
      var a = doc.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = url;
      el.appendChild(a);
    } else {
      el.appendChild(doc.createTextNode(TEXT_NO_LINK));
    }
    var close = doc.createElement("button");
    close.type = "button"; close.textContent = "\u00d7"; close.setAttribute("aria-label", "Dismiss");
    close.style.position = "absolute"; close.style.right = "8px"; close.style.top = "4px";
    close.style.border = "0"; close.style.background = "transparent"; close.style.fontSize = "20px"; close.style.cursor = "pointer";
    close.onclick = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    el.appendChild(close);
    (doc.body || doc.documentElement).appendChild(el);
    return el;
  }

  function run(win, doc) {
    var r = check(win);
    if (r.embedded) show(win, doc);
    return r;
  }

  return { check: check, show: show, run: run, ID: ID };
});
