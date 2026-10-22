// Image proofs (JPG / PNG): header checks as perdiem/proofs.py, then decoding and re-encoding for
// the PDF, all in the browser.
//   images.headerSize(bytes) -> {kind: "jpeg"|"png", width, height}   (throws Error(message))
//   images.check(bytes) -> {kind, width, height}: headerSize + the 40 MP limit, BEFORE any decoding
//   images.prepare(bytes, env?) -> Promise<{bytes, type, width, height, naturalWidth, naturalHeight}>
//     bytes/type: the image for the PDF ("image/jpeg" or "image/png"), its longest side <= 2400 px;
//     width/height: its pixel size; naturalWidth/naturalHeight: the decoded original, EXIF
//     orientation applied (what Edge lays out as the <img>'s natural size in the local app).
//     JPEG sources become JPEG (quality 0.9); PNG sources stay PNG when they have any transparency,
//     else JPEG. Errors are Error(message) with the English texts of perdiem/proofs.py.
//
// env (injectable; the default is the browser's, built on createImageBitmap and a canvas):
//   env.decode(bytes, type, {imageOrientation: "from-image"}) -> Promise<bitmap>
//       bitmap: {width, height, close?()} with the EXIF orientation applied; rejects when the
//       image cannot be decoded.
//   env.draw(bitmap, width, height) -> Promise<surface>: a scaled copy (high quality smoothing)
//       surface.hasAlpha() -> boolean (any pixel not fully opaque)
//       surface.encode(type, quality) -> Promise<{bytes: Uint8Array, type}> (the type really
//       written: a canvas may fall back to PNG), surface.close?()
// In Node there is no decoder: tests pass their own env (web/tools/node_image_env.js reads the
// pixels Pillow decoded for each fixture file).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    var ns = (root.PerDiemEngine = root.PerDiemEngine || {});
    ns.images = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  var MAX_PIXELS = 40000000;
  var MAX_SIDE = 2400;
  var JPEG_QUALITY = 0.9;
  var MSG_UNREADABLE = "This image could not be read.";
  var MSG_TOO_LARGE = "This image is too large (over 40 megapixels). Use a smaller photo.";
  var PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function isJpeg(b) { return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; }
  function isPng(b) { return b.length >= 8 && PNG_MAGIC.every(function (v, i) { return b[i] === v; }); }
  function u16(b, i) { return (b[i] << 8) | b[i + 1]; }
  function u32(b, i) { return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }

  // proofs._png_size: IHDR right after the signature.
  function pngSize(b) {
    if (b.length < 24 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") throw new Error(MSG_UNREADABLE);
    return { width: u32(b, 16), height: u32(b, 20) };
  }

  // proofs._jpeg_size: a bounded marker walk to the first SOFn (not DHT/JPG/DAC).
  function jpegSize(b) {
    var i = 2, n = b.length;
    for (var step = 0; step < 4096; step++) {
      while (i < n && b[i] !== 0xff) i++;
      while (i < n && b[i] === 0xff) i++;
      if (i >= n) break;
      var marker = b[i];
      i++;
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (i + 2 > n) break;
      var seglen = u16(b, i);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (seglen < 7 || i + 7 > n) break;
        return { width: u16(b, i + 5), height: u16(b, i + 3) };
      }
      if (seglen < 2) break;
      i += seglen;
    }
    throw new Error(MSG_UNREADABLE);
  }

  function headerSize(b) {
    if (isJpeg(b)) { var j = jpegSize(b); return { kind: "jpeg", width: j.width, height: j.height }; }
    if (isPng(b)) { var p = pngSize(b); return { kind: "png", width: p.width, height: p.height }; }
    throw new Error(MSG_UNREADABLE);
  }

  // proofs._check_image
  function check(b) {
    var h = headerSize(b);
    if (h.width <= 0 || h.height <= 0) throw new Error(MSG_UNREADABLE);
    if (h.width * h.height > MAX_PIXELS) throw new Error(MSG_TOO_LARGE);
    return h;
  }

  function targetSize(w, h) {
    var side = Math.max(w, h);
    if (side <= MAX_SIDE) return { width: w, height: h };
    var s = MAX_SIDE / side;
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }

  function sniffType(b) { return isJpeg(b) ? "image/jpeg" : isPng(b) ? "image/png" : null; }

  // ---- the browser's env: createImageBitmap + (Offscreen)Canvas ----
  function browserEnv() {
    if (typeof root.createImageBitmap !== "function") return null;
    function canvas(w, h) {
      if (typeof root.OffscreenCanvas === "function") return new root.OffscreenCanvas(w, h);
      var c = root.document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    }
    function toBlob(c, type, quality) {
      if (typeof c.convertToBlob === "function") return c.convertToBlob({ type: type, quality: quality });
      return new Promise(function (resolve, reject) {
        c.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error("toBlob failed")); }, type, quality);
      });
    }
    return {
      decode: function (bytes, type, opts) {
        return root.createImageBitmap(new root.Blob([bytes], { type: type }), opts);
      },
      draw: async function (bitmap, w, h) {
        var c = canvas(w, h), ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, h);
        return {
          hasAlpha: function () {
            var d = ctx.getImageData(0, 0, w, h).data;
            for (var i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
            return false;
          },
          encode: async function (type, quality) {
            var blob = await toBlob(c, type, quality);
            var out = new Uint8Array(await blob.arrayBuffer());
            return { bytes: out, type: sniffType(out) || blob.type };
          },
          close: function () { c.width = 0; c.height = 0; }
        };
      }
    };
  }

  async function prepare(bytes, env) {
    var h = check(bytes);
    env = env || browserEnv();
    if (!env) throw new Error("No image decoder is available in this browser.");
    var type = h.kind === "png" ? "image/png" : "image/jpeg";
    var bitmap, surface;
    try {
      bitmap = await env.decode(bytes, type, { imageOrientation: "from-image" });
    } catch (e) {
      throw new Error(MSG_UNREADABLE);
    }
    try {
      var w = bitmap.width, hh = bitmap.height;
      if (!(w > 0 && hh > 0)) throw new Error(MSG_UNREADABLE);
      if (w * hh > MAX_PIXELS) throw new Error(MSG_TOO_LARGE);
      var t = targetSize(w, hh);
      surface = await env.draw(bitmap, t.width, t.height);
      var outType = h.kind === "png" && surface.hasAlpha() ? "image/png" : "image/jpeg";
      var out = await surface.encode(outType, JPEG_QUALITY);
      var realType = sniffType(out.bytes);
      if (!realType) throw new Error(MSG_UNREADABLE);
      return { bytes: out.bytes, type: realType, width: t.width, height: t.height, naturalWidth: w, naturalHeight: hh };
    } catch (e) {
      throw new Error(e && (e.message === MSG_TOO_LARGE || e.message === MSG_UNREADABLE) ? e.message : MSG_UNREADABLE);
    } finally {
      if (surface && typeof surface.close === "function") surface.close();
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
  }

  return { headerSize: headerSize, check: check, prepare: prepare, targetSize: targetSize, isJpeg: isJpeg, isPng: isPng,
    MAX_PIXELS: MAX_PIXELS, MAX_SIDE: MAX_SIDE, JPEG_QUALITY: JPEG_QUALITY,
    MSG_UNREADABLE: MSG_UNREADABLE, MSG_TOO_LARGE: MSG_TOO_LARGE };
});
