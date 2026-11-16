/* orbit.js — a Sentinel-2 style satellite circling the globe, drawn on a canvas above the map.
   The orbit is to scale: 786 km above a 6,371 km Earth, near-polar like the real sun-synchronous orbit.
   It only draws while the whole globe is in view, and it stops its animation loop when it has nothing to draw. */

const ALT = 786 / 6371;        // Sentinel-2 altitude as a share of Earth's radius
const SQUASH = 0.34;           // how edge-on we see the orbit plane (minor / major axis)
const TILT = -0.22;            // rotation of the ellipse on screen, radians
const PERIOD = 16000;          // ms per lap (the real one takes 100 minutes)

export function createOrbit(map, canvas) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, enabled = true;

  function geometry() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = map.getCenter(); const R = 512 * Math.pow(2, map.getZoom()) / (2 * Math.PI) / Math.cos(c.lat * Math.PI / 180);
    const p = map.project(c);
    return { w, h, R, cx: p.x, cy: p.y, visible: enabled && document.body.dataset.projection === 'globe' && R < Math.min(w, h) * 0.62 && R > 40 };
  }
  /** Point on the orbit for angle a. front = on our side of the globe. */
  function point(g, a) {
    const Ro = g.R * (1 + ALT); const x0 = SQUASH * Ro * Math.sin(a), y0 = -Ro * Math.cos(a);
    const x = g.cx + x0 * Math.cos(TILT) - y0 * Math.sin(TILT), y = g.cy + x0 * Math.sin(TILT) + y0 * Math.cos(TILT);
    const front = Math.sin(a) >= 0; const hidden = !front && Math.hypot(x - g.cx, y - g.cy) < g.R * 0.995;
    return { x, y, front, hidden };
  }
  function draw(now) {
    const g = geometry(); ctx.clearRect(0, 0, g.w, g.h);
    if (!g.visible) return false;
    const a0 = reduced ? 0.9 : (now % PERIOD) / PERIOD * Math.PI * 2;
    // orbit ring
    const STEPS = 180; ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (let i = 0; i < STEPS; i++) {
      const p = point(g, i / STEPS * Math.PI * 2), q = point(g, (i + 1) / STEPS * Math.PI * 2);
      if (p.hidden || q.hidden) continue;
      ctx.strokeStyle = p.front ? 'rgba(160,215,255,0.38)' : 'rgba(160,215,255,0.16)';
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    // glowing trail behind the satellite
    for (let i = 1; i <= 40; i++) {
      const p = point(g, a0 - i * 0.012), q = point(g, a0 - (i - 1) * 0.012); if (p.hidden || q.hidden) continue;
      ctx.strokeStyle = `rgba(127,240,200,${0.55 * (1 - i / 40)})`; ctx.lineWidth = 2.2 * (1 - i / 40) + 0.4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    const s = point(g, a0);
    if (!s.hidden) {
      const n = point(g, a0 + 0.02); const dir = Math.atan2(n.y - s.y, n.x - s.x); const k = Math.max(0.8, Math.min(1.5, g.R / 220)) * (s.front ? 1 : 0.8);
      // the strip of ground it images: a faint beam toward the Earth's centre, only on our side
      if (s.front) {
        const grd = ctx.createLinearGradient(s.x, s.y, g.cx, g.cy); grd.addColorStop(0, 'rgba(127,240,200,0.30)'); grd.addColorStop(0.35, 'rgba(127,240,200,0)');
        ctx.strokeStyle = grd; ctx.lineWidth = 7 * k; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(g.cx, g.cy); ctx.stroke();
      }
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(dir); ctx.globalAlpha = s.front ? 1 : 0.6;
      ctx.shadowColor = '#7ff0c8'; ctx.shadowBlur = 12 * k;
      ctx.fillStyle = '#5aa0ff'; ctx.fillRect(-11 * k, -2.2 * k, 7 * k, 4.4 * k); ctx.fillRect(4 * k, -2.2 * k, 7 * k, 4.4 * k);   // solar panels
      ctx.fillStyle = '#f4f8ff'; ctx.fillRect(-3.4 * k, -3.2 * k, 6.8 * k, 6.4 * k);                                              // body
      ctx.restore();
      if (s.front && g.R > 120) {
        ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.fillStyle = 'rgba(220,240,255,0.92)'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
        ctx.fillText('Sentinel-2 · 786 km up', s.x + 14 * k, s.y - 8 * k); ctx.shadowBlur = 0;
      }
    }
    return true;
  }
  function loop(now) { raf = 0; if (draw(now) && !reduced) raf = requestAnimationFrame(loop); }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  map.on('move', kick); map.on('moveend', kick); window.addEventListener('resize', kick); kick();
  return { setEnabled(v) { enabled = v; kick(); }, kick };
}
