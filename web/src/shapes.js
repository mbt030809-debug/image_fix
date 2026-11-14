// 벡터 도형/스티커 경로 (단위 정사각형 -0.5..0.5 기준 Path2D)
const TAU = Math.PI * 2;

function poly(pts) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}
function star(n, ro, ri, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro, a = rot + (i * Math.PI) / n;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return poly(pts);
}
function ngon(n, r = 0.5, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([Math.cos(rot + (i * TAU) / n) * r, Math.sin(rot + (i * TAU) / n) * r]);
  return poly(pts);
}
function roundRectPath(x, y, w, h, r) {
  const p = new Path2D();
  p.moveTo(x + r, y);
  p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r);
  p.closePath();
  return p;
}

export const SHAPE_LIST = [
  ['rect', '사각형', 'Rectangle'], ['round', '둥근 사각형', 'Rounded'], ['ellipse', '원', 'Circle'], ['triangle', '삼각형', 'Triangle'],
  ['diamond', '마름모', 'Diamond'], ['pentagon', '오각형', 'Pentagon'], ['hexagon', '육각형', 'Hexagon'], ['star', '별', 'Star'],
  ['sparkle', '반짝', 'Sparkle'], ['heart', '하트', 'Heart'], ['arrow', '화살표', 'Arrow'], ['line', '선', 'Line'],
  ['speech', '말풍선', 'Speech'], ['cloud', '구름', 'Cloud'], ['moon', '달', 'Moon'], ['bolt', '번개', 'Bolt'],
  ['drop', '물방울', 'Drop'], ['cross', '더하기', 'Plus'], ['ring', '링', 'Ring'], ['badge', '배지', 'Badge'],
  ['ribbon', '리본', 'Ribbon'], ['burst', '폭발', 'Burst'], ['check', '체크', 'Check'], ['flower', '꽃', 'Flower'],
];

const cache = new Map();
/** 단위 공간 경로. 닫힌 도형은 fill, line 은 stroke 전용 */
export function shapePath(kind, aspect = 1) {
  const key = kind;
  if (cache.has(key)) return cache.get(key);
  let p;
  switch (kind) {
    case 'rect': p = new Path2D(); p.rect(-0.5, -0.5, 1, 1); break;
    case 'round': p = roundRectPath(-0.5, -0.5, 1, 1, 0.18); break;
    case 'ellipse': p = new Path2D(); p.ellipse(0, 0, 0.5, 0.5, 0, 0, TAU); break;
    case 'triangle': p = poly([[0, -0.5], [0.5, 0.5], [-0.5, 0.5]]); break;
    case 'diamond': p = poly([[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]]); break;
    case 'pentagon': p = ngon(5, 0.52); break;
    case 'hexagon': p = ngon(6, 0.5, 0); break;
    case 'star': p = star(5, 0.52, 0.22); break;
    case 'sparkle': p = poly([[0, -0.5], [0.09, -0.09], [0.5, 0], [0.09, 0.09], [0, 0.5], [-0.09, 0.09], [-0.5, 0], [-0.09, -0.09]]); break;
    case 'burst': p = star(12, 0.5, 0.36); break;
    case 'heart': {
      p = new Path2D();
      p.moveTo(0, 0.46);
      p.bezierCurveTo(-0.62, 0.02, -0.46, -0.5, -0.02, -0.28);
      p.lineTo(0, -0.26);
      p.lineTo(0.02, -0.28);
      p.bezierCurveTo(0.46, -0.5, 0.62, 0.02, 0, 0.46);
      p.closePath(); break;
    }
    case 'arrow': p = poly([[-0.5, -0.14], [0.1, -0.14], [0.1, -0.4], [0.5, 0], [0.1, 0.4], [0.1, 0.14], [-0.5, 0.14]]); break;
    case 'line': p = new Path2D(); p.moveTo(-0.5, 0); p.lineTo(0.5, 0); break;
    case 'speech': {
      p = new Path2D();
      const x = -0.5, y = -0.5, w = 1, hh = 0.78, r = 0.16;
      p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + hh, r); p.arcTo(x + w, y + hh, x, y + hh, r);
      p.lineTo(-0.1, y + hh); p.lineTo(-0.28, 0.5); p.lineTo(-0.28, y + hh);
      p.arcTo(x, y + hh, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath(); break;
    }
    case 'cloud': {
      p = new Path2D();
      p.moveTo(-0.32, 0.3);
      p.arc(-0.32, 0.12, 0.18, Math.PI / 2, Math.PI * 1.5);
      p.arc(-0.08, -0.12, 0.24, Math.PI, Math.PI * 1.95);
      p.arc(0.22, -0.02, 0.2, Math.PI * 1.35, Math.PI * 2.5);
      p.arc(0.32, 0.14, 0.16, -Math.PI / 2, Math.PI / 2);
      p.closePath(); break;
    }
    case 'moon': {
      p = new Path2D();
      p.arc(0, 0, 0.5, -1.2, 1.2, false);
      p.arc(0.2, 0, 0.4, 1.0, -1.0, true);
      p.closePath(); break;
    }
    case 'bolt': p = poly([[0.1, -0.5], [-0.32, 0.08], [-0.02, 0.08], [-0.12, 0.5], [0.32, -0.1], [0.02, -0.1]]); break;
    case 'drop': {
      p = new Path2D();
      p.moveTo(0, -0.5); p.bezierCurveTo(0.1, -0.3, 0.38, -0.05, 0.38, 0.14); p.arc(0, 0.14, 0.38, 0, Math.PI, false);
      p.bezierCurveTo(-0.38, -0.05, -0.1, -0.3, 0, -0.5); p.closePath(); break;
    }
    case 'cross': p = poly([[-0.16, -0.5], [0.16, -0.5], [0.16, -0.16], [0.5, -0.16], [0.5, 0.16], [0.16, 0.16], [0.16, 0.5], [-0.16, 0.5], [-0.16, 0.16], [-0.5, 0.16], [-0.5, -0.16], [-0.16, -0.16]]); break;
    case 'ring': {
      p = new Path2D(); p.ellipse(0, 0, 0.5, 0.5, 0, 0, TAU); p.moveTo(0.3, 0); p.ellipse(0, 0, 0.3, 0.3, 0, 0, TAU, true); break;
    }
    case 'badge': {
      p = star(16, 0.5, 0.44); break;
    }
    case 'ribbon': p = poly([[-0.5, -0.22], [0.5, -0.22], [0.36, 0], [0.5, 0.22], [-0.5, 0.22], [-0.36, 0]]); break;
    case 'check': p = poly([[-0.42, 0.02], [-0.28, -0.12], [-0.1, 0.06], [0.3, -0.34], [0.44, -0.2], [-0.1, 0.34]]); break;
    case 'flower': {
      p = new Path2D();
      for (let i = 0; i < 6; i++) { const a = (i * TAU) / 6; p.moveTo(Math.cos(a) * 0.3 + 0.2, Math.sin(a) * 0.3); p.ellipse(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.2, 0.2, 0, 0, TAU); }
      break;
    }
    default: p = new Path2D(); p.rect(-0.5, -0.5, 1, 1);
  }
  cache.set(key, p);
  void aspect;
  return p;
}

export const OPEN_SHAPES = new Set(['line']);
export const SHAPE_DEFAULTS = {
  heart: { fill: '#ff3b5c' }, star: { fill: '#ffcc00' }, sparkle: { fill: '#ffffff' }, bolt: { fill: '#ffd60a' }, cloud: { fill: '#ffffff' },
  moon: { fill: '#ffe08a' }, drop: { fill: '#4cc3ff' }, burst: { fill: '#ff9f0a' }, badge: { fill: '#ff453a' }, ribbon: { fill: '#bf5af2' },
  check: { fill: '#30d158' }, flower: { fill: '#ff7ab8' }, speech: { fill: '#ffffff' }, arrow: { fill: '#ffffff' },
};

export const EMOJI_CATS = [
  ['표정', 'Faces', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏 😌 😴 🤔 🤭 😮 😱 😭 😢 😤 😡 🥺 🤯 😈 👻 💀 🤖 👽 😺 🙈 🙉 🙊'],
  ['사랑', 'Love', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💖 💗 💓 💞 💕 💘 💝 💌 💋 💍 🌹 🥀 💐 🎀 💑 😻'],
  ['제스처', 'Hands', '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👋 🙌 👏 🙏 💪 ✊ 👊 🤝 ☝️ 👆 👇 👉 👈 🫶 ✍️ 💅'],
  ['자연', 'Nature', '🌞 🌝 🌛 ⭐ 🌟 ✨ 💫 ⚡ 🔥 💧 🌈 ☁️ ⛅ 🌧️ ❄️ ☃️ 🌸 🌼 🌻 🌷 🍀 🌿 🌴 🌵 🍁 🍂 🌊 🌍 🏔️ 🌋'],
  ['동물', 'Animals', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐙 🐬 🐳 🦈 🐾'],
  ['음식', 'Food', '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥑 🍕 🍔 🍟 🌭 🍣 🍜 🍰 🧁 🍩 🍪 🍫 🍦 ☕ 🍵 🍺 🍷 🥂 🍾'],
  ['활동', 'Activity', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🎮 🎯 🎲 🎨 🎬 🎤 🎧 🎸 🎹 🏆 🥇 🎉 🎊 🎁 🎂 🎈'],
  ['여행', 'Travel', '🚗 🚕 🚌 🚲 🛵 ✈️ 🚀 🚁 ⛵ 🚢 🏠 🏰 🗼 🗽 ⛺ 🏖️ 🏝️ 🗺️ 📍 🧭'],
  ['기호', 'Symbols', '💯 ✅ ❌ ⭕ ❗ ❓ ➕ ➖ ➡️ ⬆️ 🔔 🔒 🔑 💡 📌 📷 📱 💻 ⌚ 🔍 🎵 🎶 ♻️ ⚠️ 🚫 🆒 🆕 🆗 🔴 🟠 🟡 🟢 🔵 🟣'],
];
