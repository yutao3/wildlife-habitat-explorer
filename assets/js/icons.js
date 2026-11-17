/* icons.js — one small set of line icons (24 × 24, drawn with a 1.8 px stroke in the current text colour).
   The HTML uses them through a hidden <svg> sprite (<use href="#i-name">); JavaScript builds them with icon(name). */

export const ICONS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  draw: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M9 12h6M12 9v6"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4.5h4.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  wind: '<path d="M3 8h10.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h15.5a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16h7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  map: '<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  satellite: '<path d="m13 7 4 4"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" transform="rotate(45 12 12)"/><path d="m4.5 9.5 3-3 3 3-3 3zM13.5 18.5l3-3 3 3-3 3z"/><path d="M5 19a4 4 0 0 0 4 0"/>',
  warning: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>',
  arrowUp: '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>',
};

const NS = 'http://www.w3.org/2000/svg';
/** An <svg> element for icon `name`. */
export function icon(name, { size = 16, cls = 'i' } = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/** A drawn moon for phase 0–1 (0 = new, 0.5 = full): a dark disc with the lit part on the correct side. */
export function moonIcon(phase, size = 16) {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', 'i moon'); s.setAttribute('aria-hidden', 'true');
  const r = 9, k = Math.cos(2 * Math.PI * phase);   // k: 1 at new moon, −1 at full moon
  const waxing = phase < 0.5; const rx = Math.abs(k) * r; const lit = '#f3ecd2';
  // lit area = half-disc on the lit side plus (gibbous) or minus (crescent) an ellipse
  const side = waxing ? 1 : 0, sweepInner = (k > 0) === waxing ? 0 : 1;
  const d = `M12 3 A${r} ${r} 0 0 ${side} 12 21 A${rx} ${r} 0 0 ${sweepInner} 12 3 Z`;
  s.innerHTML = `<circle cx="12" cy="12" r="${r}" fill="#2a3446" stroke="#8a95a8" stroke-width="1"/><path d="${d}" fill="${lit}"/>`;
  return s;
}

/** The sprite injected once into the page so HTML can write <svg class="i"><use href="#i-name"/></svg>. */
export function installSprite() {
  if (document.getElementById('icon-sprite')) return;
  const sym = Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('');
  const holder = document.createElement('div'); holder.id = 'icon-sprite'; holder.hidden = true;
  holder.innerHTML = `<svg xmlns="${NS}" style="position:absolute;width:0;height:0">${sym}</svg>`;
  document.body.prepend(holder);
}
