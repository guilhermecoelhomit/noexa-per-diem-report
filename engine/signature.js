// Signature PNG validation, a port of perdiem/storage.py::_decode_ink_pixels / save_signature:
// 8-bit non-interlaced PNG, at least MIN_INK visible non-white pixels. Inflate uses the platform's
// DecompressionStream (browsers and Node >= 18), so validate() is async. Errors are thrown as
// Error with the same messages as the Python version.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    (root.PerDiemEngine = root.PerDiemEngine || {}).signature = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var MIN_INK = 5, MAX_SIDE = 4096, MAX_RAW = 64 * 1024 * 1024;
  var CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // grayscale, RGB, gray+alpha, RGBA (8-bit)

  function fail(msg) { return new Error(msg); }
  function u32(b, p) { return ((b[p] * 16777216) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]); }

  // Inflate a zlib stream, giving up (null) when more than `limit` bytes come out or the data is bad.
  async function inflate(data, limit) {
    if (typeof DecompressionStream === "undefined") throw fail("invalid PNG");
    var ds = new DecompressionStream("deflate");
    var writer = ds.writable.getWriter();
    var writing = writer.write(data).then(function () { return writer.close(); }).catch(function () { /* surfaced by the reader */ });
    var reader = ds.readable.getReader(), chunks = [], total = 0;
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        if (total > limit) { reader.cancel().catch(function () {}); await writing; return null; }
        chunks.push(r.value);
      }
    } catch (e) {
      await writing;
      return null;
    }
    await writing;
    var out = new Uint8Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  async function inkPixels(png) {
    var i;
    if (png.length < 8) throw fail("file is not a PNG");
    for (i = 0; i < 8; i++) if (png[i] !== MAGIC[i]) throw fail("file is not a PNG");
    var pos = 8, ihdr = null, idat = [], idatLen = 0;
    while (pos + 8 <= png.length) {
      var length = u32(png, pos), type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
      var body = png.subarray(pos + 8, pos + 8 + length);
      pos += 12 + length;
      if (type === "IHDR") {
        if (body.length !== 13) throw fail("invalid PNG");
        ihdr = { w: u32(body, 0), h: u32(body, 4), depth: body[8], ctype: body[9], interlace: body[12] };
      } else if (type === "IDAT") {
        idat.push(body); idatLen += body.length;
      } else if (type === "IEND") break;
    }
    if (ihdr === null || idatLen === 0) throw fail("invalid PNG");
    if (ihdr.interlace !== 0) throw fail("interlaced PNG is not supported");
    if (ihdr.depth !== 8 || !(ihdr.ctype in CHANNELS)) throw fail("unsupported PNG format (use 8-bit RGBA)");
    var ch = CHANNELS[ihdr.ctype], width = ihdr.w, height = ihdr.h;
    var stride = width * ch, expected = (stride + 1) * height;
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || expected > MAX_RAW) throw fail("image too large");
    var joined = new Uint8Array(idatLen), o = 0;
    idat.forEach(function (c) { joined.set(c, o); o += c.length; });
    var raw = await inflate(joined, expected);
    if (raw === null || raw.length !== expected) throw fail("invalid PNG");

    var prev = new Uint8Array(stride), line = new Uint8Array(stride), ink = 0, p = 0, y, x;
    for (y = 0; y < height; y++) {
      var ft = raw[p];
      for (x = 0; x < stride; x++) line[x] = raw[p + 1 + x];
      p += stride + 1;
      if (ft === 1) {
        for (x = ch; x < stride; x++) line[x] = (line[x] + line[x - ch]) & 255;
      } else if (ft === 2) {
        for (x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
      } else if (ft === 3) {
        for (x = 0; x < stride; x++) {
          var left = x >= ch ? line[x - ch] : 0;
          line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255;
        }
      } else if (ft === 4) {
        for (x = 0; x < stride; x++) {
          var a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
          var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          var pred = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          line[x] = (line[x] + pred) & 255;
        }
      } else if (ft !== 0) throw fail("invalid PNG");
      for (x = 0; x < stride; x += ch) {
        var visible, white;
        if (ihdr.ctype === 6) { visible = line[x + 3] > 0; white = line[x] === 255 && line[x + 1] === 255 && line[x + 2] === 255; }
        else if (ihdr.ctype === 4) { visible = line[x + 1] > 0; white = line[x] === 255; }
        else if (ihdr.ctype === 2) { visible = true; white = line[x] === 255 && line[x + 1] === 255 && line[x + 2] === 255; }
        else { visible = true; white = line[x] === 255; }
        if (visible && !white) ink++;
      }
      var t = prev; prev = line; line = t;
    }
    return ink;
  }

  // Resolves when the PNG is an acceptable signature; rejects with Error(message) otherwise.
  async function validate(png) {
    if ((await inkPixels(png)) < MIN_INK) throw fail("blank signature");
  }

  return { validate: validate, inkPixels: inkPixels, MIN_INK: MIN_INK };
});
