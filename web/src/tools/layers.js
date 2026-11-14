// 레이어 목록: 표시/숨김, 선택(편집 도구로 이동), 순서, 삭제
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { IconBtn, Btn } from '../ui/components.js';

const LABEL = (L) => {
  if (L.t === 'text') return '“' + String(L.text || '').replace(/\n/g, ' ').slice(0, 14) + '”';
  if (L.t === 'emoji') return L.ch;
  if (L.t === 'shape') return t('도형', 'Shape') + ' · ' + L.kind;
  if (L.t === 'image') return t('사진', 'Photo');
  if (L.t === 'draw') return t('그리기', 'Drawing');
  return L.t;
};
const ICON = { text: 'type', emoji: 'smile', shape: 'shapes', image: 'image', draw: 'pencil' };

export function open(ed, body) {
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  function render() {
    list.replaceChildren();
    const layers = ed.doc().layers;
    if (!layers.length) { list.append(h('p', { class: 'sheet-note' }, t('아직 레이어가 없어요. 텍스트·스티커·그리기 도구로 추가해 보세요.', 'No layers yet. Add some with Text, Stickers or Draw.'))); return; }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const row = h('div', { class: 'layer-row', 'aria-current': String(ed.sel === L.id) },
        IconBtn(L.hidden ? 'eye-off' : 'eye', L.hidden ? t('보이기', 'Show') : t('숨기기', 'Hide'), () => { ed.updateLayer(L.id, { hidden: !L.hidden }, true, t('레이어 표시', 'Visibility')); render(); }),
        h('button', { class: 'nm', type: 'button' }, icon(ICON[L.t] || 'layers', 'sm'), h('span', { style: { marginLeft: '8px', overflow: 'hidden', textOverflow: 'ellipsis' } }, LABEL(L))),
        IconBtn('arrow-up', t('앞으로', 'Forward'), () => { ed.moveLayer(L.id, 1); render(); }),
        IconBtn('arrow-down', t('뒤로', 'Backward'), () => { ed.moveLayer(L.id, -1); render(); }),
        IconBtn('trash-2', t('삭제', 'Delete'), () => { ed.removeLayer(L.id); render(); }));
      row.querySelector('.nm').addEventListener('click', () => {
        ed.sel = L.id;
        ed.openTool(L.t === 'text' ? 'text' : L.t === 'draw' ? 'draw' : 'sticker');
      });
      list.append(row);
    }
  }
  ed.setPeek(false);
  body.append(list);
  render();
  ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  return { refresh: render };
}
