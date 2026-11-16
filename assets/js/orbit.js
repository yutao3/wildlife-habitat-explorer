/* orbit.js — the free satellites behind WildScope, circling the globe on a canvas above the map.
   Orbit heights are to scale against a 6,371 km Earth. It only draws while the whole globe is in view,
   runs at about 30 frames a second, and stops its loop when there is nothing to draw. */

const EARTH = 6371;
/* name, height (km), what WildScope uses it for; squash = how edge-on we see the orbit, tilt = its rotation on screen (rad) */
export const SATELLITES = [
  { name: 'Sentinel-2', alt: 786, use: 'habitat scores', squash: 0.34, tilt: -0.22, period: 16000, phase: 0.0, color: '#7ff0c8' },
  { name: 'Sentinel-1 radar', alt: 693, use: 'crop & forest maps', squash: 0.22, tilt: 0.30, period: 15200, phase: 2.1, color: '#ffd27f' },
  { name: 'Terra · MODIS', alt: 705, use: 'greenness every 8 days', squash: 0.50, tilt: -0.05, period: 15400, phase: 4.0, color: '#9fd0ff' },
  { name: 'Suomi NPP · VIIRS', alt: 824, use: 'daily view', squash: 0.16, tilt: -0.50, period: 16600, phase: 5.2, color: '#ffa9c6' },
  { name: 'ISS · GEDI laser', alt: 420, use: 'forest height', squash: 0.42, tilt: 0.95, period: 13000, phase: 1.0, color: '#d6c2ff' },
];

export function createOrbit(map, canvas) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, enabled = true, last = 0;

  function geometry() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = map.getCenter(); const R = 512 * Math.pow(2, map.getZoom()) / (2 * Math.PI) / Math.cos(c.lat * Math.PI / 180);
    const p = map.project(c);
    return { w, h, R, cx: p.x, cy: p.y, visible: enabled && !document.hidden && document.body.dataset.projection === 'globe' && R < Math.min(w, h) * 0.62 && R > 40 };
  }
  /** Point on a satellite's orbit for angle a. hidden = behind the Earth. */
  function point(g, s, a) {
    const Ro = g.R * (1 + s.alt / EARTH); const x0 = s.squash * Ro * Math.sin(a), y0 = -Ro * Math.cos(a);
    const x = g.cx + x0 * Math.cos(s.tilt) - y0 * Math.sin(s.tilt), y = g.cy + x0 * Math.sin(s.tilt) + y0 * Math.cos(s.tilt);
    const front = Math.sin(a) >= 0; return { x, y, front, hidden: !front && Math.hypot(x - g.cx, y - g.cy) < g.R * 0.995 };
  }
  function ring(g, s) {   // two strokes per orbit (near side, far side) instead of hundreds of tiny ones
    for (const near of [true, false]) {
      ctx.beginPath(); let pen = false;
      for (let i = 0; i <= 120; i++) { const p = point(g, s, i / 120 * Math.PI * 2); if (p.hidden || p.front !== near) { pen = false; continue; } if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; } }
      ctx.globalAlpha = near ? 0.34 : 0.13; ctx.strokeStyle = s.color; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function craft(g, s, a0, withLabel) {
    for (let i = 1; i <= 24; i++) {   // glowing trail
      const p = point(g, s, a0 - i * 0.018), q = point(g, s, a0 - (i - 1) * 0.018); if (p.hidden || q.hidden) continue;
      ctx.globalAlpha = 0.6 * (1 - i / 24); ctx.strokeStyle = s.color; ctx.lineWidth = 2.2 * (1 - i / 24) + 0.4; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const p = point(g, s, a0); if (p.hidden) return;
    const n = point(g, s, a0 + 0.02); const dir = Math.atan2(n.y - p.y, n.x - p.x); const k = Math.max(0.75, Math.min(1.4, g.R / 230)) * (p.front ? 1 : 0.8);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(dir); ctx.globalAlpha = p.front ? 1 : 0.55; ctx.shadowColor = s.color; ctx.shadowBlur = 10 * k;
    ctx.fillStyle = '#5aa0ff'; ctx.fillRect(-10 * k, -2 * k, 6.4 * k, 4 * k); ctx.fillRect(3.6 * k, -2 * k, 6.4 * k, 4 * k);   // solar panels
    ctx.fillStyle = '#f4f8ff'; ctx.fillRect(-3 * k, -2.9 * k, 6 * k, 5.8 * k);                                               // body
    ctx.restore();
    if (withLabel && p.front && g.R > 110) {
      ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.fillStyle = s.color; ctx.font = '700 11px Inter, system-ui, sans-serif'; ctx.fillText(s.name, p.x + 13 * k, p.y - 6 * k);
      ctx.fillStyle = 'rgba(225,238,255,0.86)'; ctx.font = '500 10px Inter, system-ui, sans-serif'; ctx.fillText(`${s.alt} km up · ${s.use}`, p.x + 13 * k, p.y + 7 * k); ctx.shadowBlur = 0;
    }
  }
  function draw(now) {
    const g = geometry(); ctx.clearRect(0, 0, g.w, g.h);
    if (!g.visible) return false;
    const few = g.w < 700;   // phones: fewer satellites and no small print
    const sats = few ? SATELLITES.slice(0, 2) : SATELLITES;
    for (const s of sats) ring(g, s);
    for (const s of sats) craft(g, s, s.phase + (reduced ? 0.9 : now / s.period * Math.PI * 2), !few || s === sats[0]);
    return true;
  }
  function loop(now) {
    raf = 0;
    if (now - last < 30 && !reduced) { raf = requestAnimationFrame(loop); return; }   // about 30 frames a second is plenty
    last = now; if (draw(now) && !reduced) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  map.on('move', kick); map.on('moveend', kick); window.addEventListener('resize', kick); document.addEventListener('visibilitychange', kick); kick();
  return { setEnabled(v) { enabled = v; kick(); }, kick };
}
