/* geotiff.js — minimal GeoTIFF writer (single band, float32, uncompressed, EPSG:4326).
   Enough for QGIS / GDAL to open the score grid with the right position and no-data value. */

export function writeGeoTiff(values, cols, rows, bbox, nodata = -9999) {
  const [w, s, e, n] = bbox;
  const px = (e - w) / cols, py = (n - s) / rows;
  const nodataStr = `${nodata}\0`;
  // Tags: [tag, type, count, value(s)]  types: 3 SHORT, 4 LONG, 12 DOUBLE, 2 ASCII
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  const tags = [
    [256, 4, 1, [cols]], [257, 4, 1, [rows]], [258, 3, 1, [32]], [259, 3, 1, [1]], [262, 3, 1, [1]],
    [273, 4, 1, [0]], [277, 3, 1, [1]], [278, 4, 1, [rows]], [279, 4, 1, [cols * rows * 4]], [284, 3, 1, [1]], [339, 3, 1, [3]],
    [33550, 12, 3, [px, py, 0]], [33922, 12, 6, [0, 0, 0, w, n, 0]], [34735, 3, geoKeys.length, geoKeys], [42113, 2, nodataStr.length, nodataStr],
  ];
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 0; const extraOff = new Map();
  const ifdStart = 8, extraStart = ifdStart + ifdSize;
  for (const t of tags) { const bytes = size[t[1]] * t[2]; if (bytes > 4) { extraOff.set(t[0], extraStart + extra); extra += bytes + (bytes % 2); } }
  const dataStart = extraStart + extra;
  const buf = new ArrayBuffer(dataStart + cols * rows * 4); const dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifdStart, true);
  dv.setUint16(ifdStart, tags.length, true);
  tags.forEach((t, k) => {
    const [tag, type, count, vals] = t; const o = ifdStart + 2 + k * 12;
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, count, true);
    const v = tag === 273 ? [dataStart] : vals;
    const at = extraOff.has(tag) ? extraOff.get(tag) : o + 8;
    if (extraOff.has(tag)) dv.setUint32(o + 8, at, true);
    for (let i = 0; i < count; i++) {
      if (type === 2) dv.setUint8(at + i, v.charCodeAt(i));
      else if (type === 3) dv.setUint16(at + 2 * i, v[i], true);
      else if (type === 4) dv.setUint32(at + 4 * i, v[i], true);
      else if (type === 12) dv.setFloat64(at + 8 * i, v[i], true);
    }
  });
  dv.setUint32(ifdStart + 2 + tags.length * 12, 0, true);
  for (let i = 0; i < cols * rows; i++) dv.setFloat32(dataStart + 4 * i, Number.isNaN(values[i]) ? nodata : values[i], true);
  return new Blob([buf], { type: 'image/tiff' });
}
