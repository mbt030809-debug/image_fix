// 도구 레지스트리 + 상위/하위 목록(분류)
// 하단 줄에는 상위 목록(GROUPS)만 보이고, 하나를 누르면 그 위에 하위 목록(items)이 뜬다. 하위를 누르면 도구 패널이 열린다.
import { t } from '../i18n.js';
import { bridge } from '../bridge.js';
import { toast, confirmDialog } from '../ui/components.js';
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
import * as bodyfix from './bodyfix.js';
import * as layers from './layers.js';
import { openGenerate } from './aigenerate.js';
import { openAiSettings } from './aisettings.js';

/** 도구(패널이 열리는 항목) — title 이 있으면 패널 제목으로 쓴다 */
export const TOOLS = [
  { id: 'crop', icon: 'crop', label: () => t('자르기', 'Crop'), open: crop.open },
  { id: 'resize', icon: 'ratio', label: () => t('크기', 'Size'), open: resize.open },
  { id: 'frame', icon: 'frame', label: () => t('프레임', 'Frame'), open: frame.open },
  { id: 'adjust', icon: 'sliders-horizontal', label: () => t('조정', 'Adjust'), open: adjust.open },
  { id: 'color', icon: 'palette', label: () => t('색상', 'Color'), open: color.open },
  { id: 'curves', icon: 'spline', label: () => t('곡선', 'Curves'), open: curves.open },
  { id: 'filter', icon: 'wand-sparkles', label: () => t('필터', 'Filters'), open: filter.open },
  { id: 'effects', icon: 'sparkles', label: () => t('효과', 'Effects'), open: effects.open },
  { id: 'retouch', icon: 'bandage', label: () => t('리터치', 'Retouch'), open: retouch.open },
  { id: 'brush', icon: 'brush', label: () => t('브러시', 'Brush'), open: brush.open },
  { id: 'cutout', icon: 'scissors', label: () => t('배경 제거', 'Cutout'), open: cutout.open },
  { id: 'body', icon: 'person-standing', label: () => t('체형', 'Body'), title: () => t('얼굴·체형 보정', 'Face & body reshape'), open: bodyfix.open },
  { id: 'text', icon: 'type', label: () => t('텍스트', 'Text'), open: text.open },
  { id: 'sticker', icon: 'smile', label: () => t('스티커', 'Stickers'), open: sticker.open },
  { id: 'draw', icon: 'pen-line', label: () => t('그리기', 'Draw'), open: draw.open },
  { id: 'ai', icon: 'lasso-select', label: () => t('영역 수정', 'Area edit'), title: () => t('AI 영역 수정', 'AI area edit'), open: aiedit.open },
  { id: 'layers', icon: 'layers', label: () => t('레이어', 'Layers'), open: layers.open },
];

const needApp = () => { toast(t('AI 기능은 앱(APK)에서만 쓸 수 있어요', 'AI features work only in the app (APK)')); };

/** 동작(패널 대신 창을 여는 항목) — run(editor) */
export const ACTIONS = [
  {
    id: 'aigen', icon: 'image-plus', label: () => t('이미지 만들기', 'Create image'),
    async run(ed) {
      if (!bridge.ai.available()) { needApp(); return; }
      // 만든 이미지를 "편집하기"로 열면 지금 사진은 닫힌다 — 저장하지 않은 변경이 있으면 먼저 알린다
      if (ed.store.isDirty()) {
        const v = await confirmDialog({
          title: t('새 이미지를 만들까요?', 'Create a new image?'),
          body: t('만든 이미지를 편집하면 지금 편집 중인 사진은 닫혀요. 저장하지 않은 변경 사항은 사라져요.', 'Editing the generated image closes the photo you are editing. Unsaved changes are lost.'),
          actions: [{ label: t('계속 편집', 'Keep editing'), value: 'keep' }, { label: t('이미지 만들기', 'Create image'), value: 'go', kind: 'filled' }],
        });
        if (v !== 'go') return;
      }
      openGenerate(ed.app);
    },
  },
  {
    id: 'aiset', icon: 'key-round', label: () => t('AI 설정', 'AI settings'),
    run(ed) { if (!bridge.ai.available()) { needApp(); return; } openAiSettings(ed.app); },
  },
];

/** 상위 목록: 하단 줄에 보이는 순서. items = 하위 목록(도구/동작 id). direct = 하위 없이 바로 열리는 항목 */
export const GROUPS = [
  { id: 'canvas', icon: 'square-dashed', label: () => t('캔버스', 'Canvas'), items: ['crop', 'resize', 'frame'] },
  { id: 'tune', icon: 'sun', label: () => t('보정', 'Tune'), items: ['adjust', 'color', 'curves', 'filter', 'effects'] },
  { id: 'refine', icon: 'scan-face', label: () => t('다듬기', 'Refine'), items: ['retouch', 'brush', 'cutout', 'body'] },
  { id: 'decor', icon: 'shapes', label: () => t('꾸미기', 'Overlay'), items: ['text', 'sticker', 'draw'] },
  { id: 'aitools', icon: 'bot', label: () => t('AI 도구', 'AI tools'), items: ['ai', 'aigen', 'aiset'] },
  { id: 'layers', icon: 'layers', label: () => t('레이어', 'Layers'), items: ['layers'], direct: true },
];

export const TOOL_BY_ID = Object.fromEntries([...TOOLS, ...ACTIONS].map((x) => [x.id, x]));

/** 도구/동작이 속한 상위 목록 id (없으면 null) */
export function groupOf(id) {
  const g = GROUPS.find((x) => x.items.includes(id));
  return g ? g.id : null;
}
