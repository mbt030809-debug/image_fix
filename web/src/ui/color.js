// 색 변환 유틸 (HEX / HSV)
export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6 || /[^0-9a-f]/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, mx ? d / mx : 0, mx];
}
export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
export const hexToHsv = (hex) => { const c = hexToRgb(hex) || [0, 0, 0]; return rgbToHsv(c[0], c[1], c[2]); };
export const hsvToHex = (h, s, v) => { const c = hsvToRgb(h, s, v); return rgbToHex(c[0], c[1], c[2]); };
export function luminance(hex) {
  const c = hexToRgb(hex) || [0, 0, 0];
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function rgba(hex, a = 1) {
  const c = hexToRgb(hex) || [0, 0, 0];
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export const PALETTE = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#af52de', '#ff2d92', '#a2845e', '#8e8e93', '#f5e6c8', '#ffd1dc', '#b8e0ff'];
