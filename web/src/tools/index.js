// 도구 레지스트리 (스트립 표시 순서)
import { t } from '../i18n.js';
import * as crop from './crop.js';
import * as resize from './resize.js';
import * as adjust from './adjust.js';
import * as filter from './filter.js';
import * as color from './color.js';
import * as curves from './curves.js';
import * as effects from './effects.js';
import * as retouch from './retouch.js';
import * as brush from './brush.js';
import * as aiedit from './aiedit.js';
import * as text from './text.js';
import * as sticker from './sticker.js';
import * as draw from './draw.js';
import * as frame from './frame.js';
import * as cutout from './cutout.js';
import * as layers from './layers.js';

export const TOOLS = [
  { id: 'crop', icon: 'crop', label: () => t('자르기', 'Crop'), open: crop.open },
  { id: 'resize', icon: 'ratio', label: () => t('크기', 'Size'), open: resize.open },
  { id: 'adjust', icon: 'sliders-horizontal', label: () => t('조정', 'Adjust'), open: adjust.open },
  { id: 'filter', icon: 'wand-sparkles', label: () => t('필터', 'Filters'), open: filter.open },
  { id: 'color', icon: 'palette', label: () => t('색상', 'Color'), open: color.open },
  { id: 'curves', icon: 'spline', label: () => t('곡선', 'Curves'), open: curves.open },
  { id: 'effects', icon: 'sparkles', label: () => t('효과', 'Effects'), open: effects.open },
  { id: 'retouch', icon: 'bandage', label: () => t('리터치', 'Retouch'), open: retouch.open },
  { id: 'brush', icon: 'brush', label: () => t('브러시', 'Brush'), open: brush.open },
  { id: 'ai', icon: 'lasso-select', label: () => t('AI 수정', 'AI edit'), open: aiedit.open },
  { id: 'text', icon: 'type', label: () => t('텍스트', 'Text'), open: text.open },
  { id: 'sticker', icon: 'smile', label: () => t('스티커', 'Stickers'), open: sticker.open },
  { id: 'draw', icon: 'pen-line', label: () => t('그리기', 'Draw'), open: draw.open },
  { id: 'frame', icon: 'frame', label: () => t('프레임', 'Frame'), open: frame.open },
  { id: 'cutout', icon: 'scissors', label: () => t('배경 제거', 'Cutout'), open: cutout.open },
  { id: 'layers', icon: 'layers', label: () => t('레이어', 'Layers'), open: layers.open },
];
