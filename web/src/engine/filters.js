// 필터(룩) 프리셋: develop 파라미터 묶음. 강도(0..100)로 섞인다.
// p 의 키는 develop.js 의 보정 스키마와 동일.

const bw = { bw: 100 };

export const FILTER_CATS = [
  ['basic', '기본'], ['portrait', '인물'], ['scenery', '풍경'], ['food', '음식'],
  ['mono', '흑백'], ['vintage', '빈티지'], ['cinema', '시네마'], ['mood', '무드'],
];

export const FILTERS = [
  // 기본
  { id: 'vivid', cat: 'basic', ko: '비비드', en: 'Vivid', p: { contrast: 14, saturation: 22, vibrance: 18, clarity: 12 } },
  { id: 'bright', cat: 'basic', ko: '화사함', en: 'Bright', p: { exposure: 14, shadows: 20, contrast: -4, vibrance: 14, highlights: -6 } },
  { id: 'soft', cat: 'basic', ko: '부드럽게', en: 'Soft', p: { contrast: -14, clarity: -22, highlights: -10, fade: 6, vibrance: 8 } },
  { id: 'crisp', cat: 'basic', ko: '또렷하게', en: 'Crisp', p: { contrast: 16, clarity: 28, sharpen: 35, texture: 14 } },
  { id: 'punch', cat: 'basic', ko: '펀치', en: 'Punch', p: { contrast: 30, saturation: 18, blacks: -10, clarity: 16 } },
  // 인물
  { id: 'skin', cat: 'portrait', ko: '피부톤', en: 'Skin', p: { temp: 8, tint: 4, contrast: -6, clarity: -14, shadows: 12, vibrance: 10, saturation: -4 } },
  { id: 'glow', cat: 'portrait', ko: '글로우', en: 'Glow', p: { exposure: 10, highlights: -14, clarity: -26, fade: 8, temp: 6, vibrance: 8 } },
  { id: 'rosy', cat: 'portrait', ko: '로지', en: 'Rosy', p: { temp: 10, tint: 16, saturation: 6, contrast: -4, fade: 10, exposure: 6 } },
  { id: 'porcelain', cat: 'portrait', ko: '도자기', en: 'Porcelain', p: { temp: -6, exposure: 12, saturation: -12, clarity: -12, contrast: -8, highlights: -6 } },
  // 풍경
  { id: 'nature', cat: 'scenery', ko: '자연', en: 'Nature', p: { saturation: 12, vibrance: 22, clarity: 18, contrast: 8, hsl: { green: [4, 22, -4], yellow: [-3, 10, 0] } } },
  { id: 'sky', cat: 'scenery', ko: '맑은 하늘', en: 'Clear sky', p: { dehaze: 20, contrast: 10, temp: -6, hsl: { blue: [-2, 34, -12], aqua: [0, 20, -6] }, clarity: 10 } },
  { id: 'golden', cat: 'scenery', ko: '골든아워', en: 'Golden hour', p: { temp: 32, tint: 6, highlights: -14, shadows: 14, contrast: 8, vibrance: 14, vignette: -12 } },
  { id: 'autumn', cat: 'scenery', ko: '가을', en: 'Autumn', p: { temp: 18, contrast: 10, saturation: 8, hsl: { yellow: [-8, 24, 0], orange: [-4, 20, 0], green: [-18, -8, 0] } } },
  // 음식
  { id: 'fresh', cat: 'food', ko: '싱싱함', en: 'Fresh', p: { saturation: 16, vibrance: 22, temp: 10, contrast: 10, clarity: 14 } },
  { id: 'cozy', cat: 'food', ko: '따끈함', en: 'Cozy', p: { temp: 22, shadows: 14, saturation: 10, vignette: -14, contrast: 6, tint: 4 } },
  // 흑백
  { id: 'mono', cat: 'mono', ko: '모노', en: 'Mono', p: { ...bw, contrast: 10 } },
  { id: 'noir', cat: 'mono', ko: '누아르', en: 'Noir', p: { ...bw, contrast: 42, blacks: -20, vignette: -36, grain: 20, clarity: 16 } },
  { id: 'silver', cat: 'mono', ko: '실버', en: 'Silver', p: { ...bw, contrast: -4, fade: 16, clarity: 10, highlights: -8 } },
  { id: 'hicon', cat: 'mono', ko: '하이콘', en: 'High contrast', p: { ...bw, contrast: 58, whites: 20, blacks: -26 } },
  { id: 'sepia', cat: 'mono', ko: '세피아', en: 'Sepia', p: { ...bw, fade: 10, splitHi: { h: 42, s: 38 }, splitLo: { h: 28, s: 32 } } },
  // 빈티지
  { id: 'retro', cat: 'vintage', ko: '레트로', en: 'Retro', p: { fade: 28, saturation: -8, temp: 14, splitLo: { h: 200, s: 20 }, splitHi: { h: 45, s: 26 }, grain: 22, vignette: -20 } },
  { id: 'film', cat: 'vintage', ko: '필름', en: 'Film', p: { contrast: 10, fade: 14, grain: 28, saturation: -6, temp: 6, curves: { l: [[0, 0.04], [0.25, 0.22], [0.75, 0.8], [1, 0.97]] } } },
  { id: 'polaroid', cat: 'vintage', ko: '폴라로이드', en: 'Polaroid', p: { fade: 22, contrast: -6, temp: 12, tint: 6, saturation: 6, vignette: -14, hsl: { blue: [-6, -14, 4] } } },
  { id: 'kodak', cat: 'vintage', ko: '코닥', en: 'Kodak', p: { temp: 14, saturation: 12, contrast: 14, grain: 14, hsl: { red: [2, 12, 0], yellow: [-4, 14, 0] } } },
  { id: 'fuji', cat: 'vintage', ko: '후지', en: 'Fuji', p: { tint: -8, saturation: 8, contrast: 12, fade: 8, grain: 12, hsl: { green: [8, 14, 0], blue: [4, 6, 0] } } },
  { id: 'faded', cat: 'vintage', ko: '빛바램', en: 'Faded', p: { fade: 42, contrast: -18, saturation: -20, temp: 4 } },
  // 시네마
  { id: 'teal', cat: 'cinema', ko: '틸&오렌지', en: 'Teal & orange', p: { splitHi: { h: 38, s: 46 }, splitLo: { h: 195, s: 52 }, contrast: 14, saturation: -4, vibrance: 8 } },
  { id: 'moody', cat: 'cinema', ko: '무디', en: 'Moody', p: { exposure: -10, contrast: 18, saturation: -18, temp: -6, vignette: -30, highlights: -12, shadows: -6 } },
  { id: 'cyber', cat: 'cinema', ko: '사이버', en: 'Cyber', p: { splitHi: { h: 320, s: 50 }, splitLo: { h: 190, s: 56 }, contrast: 18, saturation: 8, blacks: -8 } },
  { id: 'dusk', cat: 'cinema', ko: '황혼', en: 'Dusk', p: { temp: 22, tint: 18, splitLo: { h: 262, s: 32 }, contrast: 8, vibrance: 10 } },
  { id: 'matte', cat: 'cinema', ko: '매트', en: 'Matte', p: { fade: 30, blacks: 12, contrast: -6, saturation: -4 } },
  // 무드
  { id: 'cold', cat: 'mood', ko: '차가움', en: 'Cold', p: { temp: -30, tint: -4, saturation: -6, contrast: 8 } },
  { id: 'warm', cat: 'mood', ko: '따뜻함', en: 'Warm', p: { temp: 30, tint: 6, saturation: 6 } },
  { id: 'lomo', cat: 'mood', ko: '로모', en: 'Lomo', p: { contrast: 30, saturation: 22, vignette: -50, grain: 14, temp: 6 } },
  { id: 'dream', cat: 'mood', ko: '몽환', en: 'Dreamy', p: { clarity: -36, exposure: 10, fade: 14, vibrance: 18, highlights: -8, splitHi: { h: 320, s: 16 } } },
  { id: 'mint', cat: 'mood', ko: '민트', en: 'Mint', p: { temp: -12, tint: -14, exposure: 8, fade: 10, saturation: -4, splitLo: { h: 170, s: 20 } } },
  { id: 'peach', cat: 'mood', ko: '피치', en: 'Peach', p: { temp: 14, tint: 12, exposure: 8, fade: 12, saturation: -2, splitHi: { h: 24, s: 20 } } },
];

export function getFilter(id) {
  return FILTERS.find((f) => f.id === id) || null;
}
