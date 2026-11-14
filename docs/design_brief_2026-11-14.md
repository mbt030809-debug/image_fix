# image_fix: Android photo-editor UI design brief

Date: 2026-11-14. Audience: the implementation agent. Stack: Java WebView shell + offline vanilla HTML/CSS/JS, Korean-first UI (English fallback), mobile-first touch, dark theme default (light optional).
Distilled from the design skills installed in `.claude/skills/` (see Appendix A) and verified (contrast ratios were computed, not guessed).

Precedence: the user's instructions, then this brief, then the individual skills.

Source tags used below:
- [WIG] web-design-guidelines (Vercel) · [UXPM] ui-ux-pro-max · [MIFB] make-interfaces-feel-better · [M3] android-design-guidelines (Material 3)
- [FD] frontend-design · [A11Y] accessibility-compliance · [VDF] visual-design-foundations · [DS] design-system-patterns · [UXCOPY] ux-copy
- [IMP] impeccable: NOT installed (its launcher downloads and executes a binary), but its plain-text reference docs (Apache-2.0) were read and are credited here
- [M3-spec] Material 3 spec values recalled from memory (the installed skill does not list them): verify against m3.material.io
- [ME] my own addition from general practice (photo-editor conventions, Korean typography, WebView specifics): verify on a real device

---

## 1. Direction (read first)

1. **Operate mode.** This is a task tool, not a landing page. Familiar beats novel; the tool should disappear into the task; color is Restrained; motion explains state only; no launch choreography; modals are the last resort (use inline/sheet first). [IMP operate.md, FD]
2. **Photo first, chrome neutral.** All chrome surfaces are neutral grays (no blue/warm tint) so they never bias how the photo's color is judged. [ME] ("Photography Studio" and "Generative Art / Canvas neutral" palettes in `ui-ux-pro-max/data/colors.csv` agree.)
3. **One accent, used only for state.** Accent color marks: the active tool, slider fill and thumb, selected chip/segment, the Save button, and the focus ring. Never decoration, never on inactive elements. [IMP operate.md]
4. **Spend boldness in one place:** the slider (the most-used control). Everything else stays quiet. [FD]
5. **Avoid template defaults** the skills warn about: purple gradients; warm-cream + terracotta; near-black + acid-green; identical rounded cards with one shadow; ALL-CAPS eyebrow labels; gradient text; glass/blur as decoration; Inter as default; everything centered; emoji as icons. Blue-on-neutral is chosen deliberately here (earned familiarity). [FD, MIFB, IMP]

## 2. Layout

### 2.1 Portrait phone (baseline 360x800 CSS px; must work 320 to 480)

```
status-bar inset (shell supplies --safe-top)
+--------------------------------------------------+
| [X]  [undo][redo][compare]              [ Save ] |  top bar 56px
+--------------------------------------------------+
|                                                  |
|             CANVAS  (grid row: 1fr)              |  --c-canvas, photo fitted with 8-12px pad
|    pinch / pan / double-tap; overlays: zoom chip |  never < 35dvh tall
|    crop handles, brush cursor                    |
|                                                  |
+--------------------------------------------------+
|  ====  (handle 32x4)                             |  bottom sheet (standard, non-modal)
|  Adjust                              [Reset]     |  header 48px; top radius 28
|  [Brightness][Contrast][Saturation][Warmth] ->   |  param chips (scroll-x)
|  Brightness                              +35     |  slider row 64px
|  ------------O-----------------------------      |
+--------------------------------------------------+
| [crop][adjust][filter][effect][text] ->          |  tool strip 72px (scroll-x), about 4.6 items visible
+--------------------------------------------------+
gesture-nav inset (shell supplies --safe-bottom)
```

Grid: `height:100vh; height:100dvh; display:grid; grid-template-rows:auto minmax(0,1fr) auto auto;` (top bar, canvas, sheet, strip). The sheet sits between canvas and strip and **pushes the canvas smaller instead of covering the photo**; the photo re-fits with a 300ms transform animation. Panels that need more room (export options, full parameter list) become an explicit modal sheet with a scrim. [ME, M3 R5.8]

### 2.2 Dimensions (CSS px; in a WebView with `width=device-width`, 1 CSS px = 1 dp)

| Element | Visual | Hit target | Notes |
|---|---|---|---|
| Top bar | 56 + safe-top | n/a | bg `--c-bg`; icon buttons 40 visual / 48 hit; 4px between buttons; Save 40px tall pill, min-width 72 |
| Tool strip | 72 + safe-bottom | item 76 wide x 72 | icon 24 inside a 56x32 pill, 4px gap, label 12/16 weight 500 (700 when selected); `padding-inline:8px` |
| Sheet | handle 32x4 at 8px from top; header 48; content padding 16 | handle+header (72px tall) is one drag/tap region | top radius 28; `max-height:42dvh`; peek about 196px; `overscroll-behavior:contain`; scrolls inside |
| Slider row | label/value line 20 + slider 48 = 64 min | 48 | see 9.1 |
| Chips | 36 tall | 48 tall | see 9.2 |
| Segmented control | 40 tall | 48 tall | see 9.3 |
| Crop handles | corner brackets 24 long x 3 thick | 48x48 zones | see 9.8 |
| Zoom chip | 32 tall | 48 | bottom-start of canvas, shows "Fit" or "250%"; tap cycles Fit, 100%, 200% |
| Snackbar | 48 to 68 | action 48 | above the tool strip, never over the sheet handle |

Rules:
- Canvas is at least 35dvh. If a sheet would break that, cap the sheet (`max-height:42dvh`, scroll inside) or promote it to a modal sheet. [ME]
- Use `100dvh`, never bare `100vh` (it ignores the browser/system bars). [UXPM viewport-units]
- Fixed bars reserve padding so scroll content is never hidden under them. [UXPM]
- Do not lock orientation. Landscape phone (`(orientation:landscape) and (max-height:500px)`) and tablet (`min-width:840px`): tool strip becomes a left rail 72px wide (vertical, scrollable), the sheet becomes a right side panel 320px wide, the canvas takes the middle; top bar stays. Tablet content max-width 560px inside panels. [M3 R2.5, UXPM adaptive-navigation]

### 2.3 Gesture arbitration

| Region | Gestures | `touch-action` |
|---|---|---|
| Canvas | 1-finger pan (when zoomed past Fit), 2-finger pinch, double-tap toggles Fit/100%; tools add their own 1-finger gestures (crop, draw) while 2-finger always navigates | `none` |
| Tool strip, chip rows | horizontal scroll | `pan-x` |
| Sheet body | vertical scroll | `pan-y` |
| Slider | horizontal drag | `pan-y` (vertical flicks still scroll the sheet) |
| Sheet handle and header | vertical drag; tap toggles peek/expanded | `none` on the handle only |
| Left/right 24px screen edges | keep free of horizontal-swipe targets (system Back gesture) | n/a |

- Compare is a **dedicated button**, never a canvas long-press (it would collide with selection, context menu and the draw tool). [UXPM gesture-conflicts, ME]
- Every drag/pinch/swipe also has a tap or button alternative (see section 10). [WIG, A11Y, UXPM `dragging-alternative`]
- Add `touch-action:manipulation` on all buttons; `-webkit-tap-highlight-color:transparent` plus your own pressed state; `user-select:none` on chrome and canvas (not on inputs). [WIG]

### 2.4 Z-index scale

`canvas 0 < canvas overlays 10 < sheet 20 = strip 20 < top bar 30 < snackbar 40 < menu/popover 50 < dialog+scrim 100`. No other values. [UXPM z-index-management]

## 3. Touch targets and spacing

- **Minimum touch target 48x48 px for everything interactive; at least 8px between targets; hit areas never overlap.** Material says 48dp, WIG/MIFB say 44, WCAG 2.2 AA floor is 24 (2.5.8), AAA is 44 (2.5.5): use 48 so all pass. [M3 R6.5, UXPM, WIG, A11Y]
- If the visual is smaller (icons 24, chips 36, Save 40), extend the hit area with a pseudo-element and **shrink it when it would collide with a neighbor**: [MIFB surfaces.md]

```css
.hit { position: relative; }
.hit::before { content: ""; position: absolute; inset: -4px 0; }      /* 40px visual -> 48px hit */
.hit-icon::before { content: ""; position: absolute; inset: -12px; }  /* 24px icon -> 48px hit */
```

- Spacing scale: **4px base** (a 4-base gives the useful middle steps an 8-only scale misses). [IMP layout.md, UXPM spacing-scale]

| Token | px | Use |
|---|---|---|
| `--sp-1` | 4 | icon to label gap in the strip; hit-area extension |
| `--sp-2` | 8 | minimum gap between touch targets; chip gap; icon to text in buttons |
| `--sp-3` | 12 | chip horizontal padding; sheet bottom padding |
| `--sp-4` | 16 | page and sheet side gutter; row padding |
| `--sp-5` | 20 | rare |
| `--sp-6` | 24 | section gap inside sheets; button horizontal padding; dialog padding |
| `--sp-8` / `--sp-10` / `--sp-12` | 32 / 40 / 48 | empty states, large separations |

- Vertical rhythm tiers: 8 (within a group), 16 (between rows), 24 (between sections), 32 (between regions). More space above a heading than below it. [UXPM pro-rules, IMP craft-floor]
- Gutters grow with width: 16px phone, 24px at 600px+. [UXPM adaptive gutters]

## 4. Typography (Korean + Latin, offline)

### 4.1 Font stack (no webfonts, nothing downloaded)

```css
--font-sans: system-ui, -apple-system, "Roboto", "Noto Sans KR", "Noto Sans CJK KR",
             "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif;
--font-mono: ui-monospace, "Roboto Mono", "SF Mono", Menlo, Consolas, monospace;   /* hex inputs only */
```

- Set `<html lang="ko">` (and switch it to `en` for the English fallback) so Chromium picks Korean-appropriate glyph fallbacks. On Android, Noto Sans CJK ships as the CJK fallback, so Hangul renders even when the Latin face (Roboto or an OEM face) has no Hangul. OEM faces (e.g. Samsung) differ: verify on a Samsung device. [ME, partially confirmed by AOSP font docs]
- **Do not ship a Korean webfont.** A Hangul font is several MB per weight even subsetted; system fonts are free, instant and match the OS. [WIG subset-fonts, ME]
- Use weights **400, 500, 700 only** (600 maps to 700 or synthesizes on many system fonts; thin weights are weak in Hangul). [ME]
- One family carries everything: headings, labels, data. No second display face in a product UI. [IMP operate.md]

### 4.2 Scale: 12 / 14 / 16 / 20 / 24 (ratio about 1.2, fixed rem, not fluid)

| Role | Size | Line height | Weight | Use |
|---|---|---|---|---|
| `headline` | 24px (1.5rem) | 32px | 500 | empty-state title only |
| `title-lg` | 20px (1.25rem) | 28px | 500 | dialog titles |
| `title` | 16px (1rem) | 24px | 500 | sheet/tool title, list headers |
| `body` | 16px | 24px | 400 | inputs (never below 16), dialog text |
| `body-sm` | 14px (0.875rem) | 22px | 400 | helper text, secondary text |
| `label` | 14px | 20px | 500 | buttons, chips, slider label, segmented, tab text |
| `label-sm` | 12px (0.75rem) | 16px | 500 | tool-strip labels, captions, units |
| `value` | 14px | 20px | 500 + `font-variant-numeric: tabular-nums` | slider/zoom/numeric readouts |

- **Hangul floor is 12px** (Material's 11sp is for Latin); never smaller for UI text. [M3 R4.2, ME]
- Always set an explicit `line-height` (never `normal`): Latin and Hangul fallbacks have different metrics and mixed lines would jump. Hangul wants 1.5 to 1.6 for running text (22/14 is 1.57). UI labels stay single-line at 1.3 to 1.4. [UXPM line-height, VDF, ME]
- Use `rem` (so system font scale and textZoom work); never fix heights that clip text: use `min-height`. Test at 130% and 200% font scale: nothing may clip or overlap. [M3 R4.4, UXPM dynamic-type]
- Korean line breaking: `:lang(ko){ word-break: keep-all; overflow-wrap: anywhere; }` (breaks only at spaces, but still wraps over-long tokens). Flex/grid text children need `min-width:0`. [ME, W3C i18n test notes]
- Letter-spacing 0 for everything (never track out Hangul). Sentence case for English; no ALL-CAPS labels. [FD, ME]
- `text-wrap: balance` on dialog titles, `text-wrap: pretty` on body copy (ignored harmlessly on old WebViews). Single-line labels: `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`. [MIFB, WIG]
- Expansion: Korean is short (노출) but the English fallback is up to about 2.5x wider (Exposure, Highlights, Perspective). Strip items and slider labels must survive the English strings (ellipsis, no clipping, no overlap with the value). [ME]
- Typographic details: `…` not `...` for loading and for actions that open more input ("Resize…", "저장 중…"); non-breaking space between number and unit (`10&nbsp;MB`); tabular numbers on every changing number. [WIG, MIFB]
- Wrap brand names, units and codes that must not be machine-translated in `translate="no"`; format numbers/dates with `Intl.*`. [WIG]

## 5. Color tokens (verified contrast)

Dark is the default (`:root`); light is `[data-theme="light"]`. Settings offer **Dark (default) / Light / System** (System sets `data-theme` from `matchMedia('(prefers-color-scheme: light)')`). Dark surfaces are tonal steps of neutral gray, not pure black; the canvas may be near-black. [M3 R1.7-1.9, UXPM color-dark-mode]

```css
:root, :root[data-theme="dark"] {
  color-scheme: dark;
  --c-canvas:#0D0D0D;   /* behind the photo */
  --c-bg:#121212;       /* app background, top bar */
  --c-s1:#1A1A1A;       /* tool strip */
  --c-s2:#222222;       /* sheet, dialog, menu */
  --c-s3:#2C2C2C;       /* resting chips, inputs, segmented track */
  --c-s4:#383838;       /* pressed surface, value bubble */
  --c-outline:#7A7A7A;  /* control boundaries (>= 3:1) */
  --c-outline-v:#3D3D3D;/* decorative dividers only */
  --c-track-off:#707070;/* inactive slider track (>= 3:1 on s2) */
  --c-text:#ECECEC;  --c-text-2:#B4B4B4;  --c-text-3:#9A9A9A;  /* primary, secondary, hint/placeholder */
  --c-accent:#8AB4F8;   --c-on-accent:#062E6F;
  --c-accent-c:#1F3A5F; --c-on-accent-c:#D6E4FF;               /* selected chip/segment/tool pill */
  --c-danger:#F2B8B5;   --c-danger-c:#601410; --c-on-danger-c:#F9DEDC;
  --c-success:#81C995;  --c-warning:#FDD663;
  --c-scrim:rgba(0,0,0,.60);
  --c-checker-a:#2A2A2A; --c-checker-b:#333333;                /* transparency checkerboard, 16px squares */
  --shadow-1:0 0 0 1px rgba(255,255,255,.08);                  /* dark: single white ring, per MIFB */
  --shadow-2:0 0 0 1px rgba(255,255,255,.08), 0 2px 6px 2px rgba(0,0,0,.35);
  --shadow-3:0 0 0 1px rgba(255,255,255,.08), 0 4px 8px 3px rgba(0,0,0,.35);
}
:root[data-theme="light"] {
  color-scheme: light;
  --c-canvas:#E4E4E4; --c-bg:#F6F6F6; --c-s1:#FFFFFF; --c-s2:#FFFFFF; --c-s3:#EEEEEE; --c-s4:#E0E0E0;
  --c-outline:#767676; --c-outline-v:#D6D6D6; --c-track-off:#8C8C8C;
  --c-text:#1C1C1C; --c-text-2:#555555; --c-text-3:#666666;
  --c-accent:#0B57D0; --c-on-accent:#FFFFFF; --c-accent-c:#D3E3FD; --c-on-accent-c:#041E49;
  --c-danger:#B3261E; --c-danger-c:#F9DEDC; --c-on-danger-c:#410E0B;
  --c-success:#137333; --c-warning:#8A5A00;
  --c-scrim:rgba(0,0,0,.32);
  --c-checker-a:#CFCFCF; --c-checker-b:#E9E9E9;
  --shadow-1:0 1px 2px rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);   /* [M3-spec] elevation 1 */
  --shadow-2:0 1px 2px rgba(0,0,0,.30), 0 2px 6px 2px rgba(0,0,0,.15);   /* elevation 2: sheet, menu */
  --shadow-3:0 1px 3px rgba(0,0,0,.30), 0 4px 8px 3px rgba(0,0,0,.15);   /* elevation 3: snackbar, dialog */
}
```

Computed WCAG contrast (all pass; text needs 4.5, non-text needs 3):

| Pair | Dark | Light |
|---|---|---|
| text on bg / s2 | 15.9 / 13.5 | 15.8 / 17.0 |
| text-2 on s2 / s3 | 7.7 / 6.7 | 7.5 / 6.4 |
| text-3 (hint, placeholder) on s2 / s3 | 5.7 / 5.0 | 5.7 / 5.0 |
| accent on s2 (text buttons, thumb) | 7.6 | 6.4 |
| on-accent on accent (filled Save) | 6.1 | 6.4 |
| on-accent-c on accent-c (selected chip) | 9.0 | 12.6 |
| danger text on s2 | 9.3 | 6.5 |
| outline on s2 / s3 (control borders) | 3.7 / 3.3 | 4.5 / 3.9 |
| inactive slider track on s2 | 3.2 | 3.4 |

Rules:
- **Semantic tokens only in components; no raw hex.** Three tiers: primitive (raw values), semantic (`--c-text`, `--c-s2`), component (`--slider-fill: var(--c-accent)`). [DS, M3 R1.2, UXPM]
- The selected-tool pill (`accent-c` on `s1`) is only 1.3 to 1.5:1 by design (same as Material), so **it must never be the only selected cue**: also use the accent filled icon, label weight 700, and `aria-selected="true"`. [WCAG 1.4.11, ME]
- Status and state never rely on color alone: error gets an icon and text, selected chip gets a check mark. [UXPM color-not-only, WIG]
- Dark mode uses lighter, desaturated tonal accents, not inverted colors; check contrast in each theme independently and keep pressed/focus/disabled states distinguishable in both. [UXPM, M3]
- No `oklch()`/`color-mix()` without a hex fallback (needs WebView 111+). [ME]
- Photo overlays (crop handles, grid, brush cursor) are white with a 1px 40%-black outer shadow so they stay visible on any photo; dim outside the crop with `rgba(0,0,0,.55)`. [ME]
- Optional image edge: `outline:1px solid rgba(0,0,0,.1)` (light) / `rgba(255,255,255,.1)` (dark) with `outline-offset:-1px`, pure black/white only, on thumbnails (filter previews, stickers). [MIFB surfaces.md]

## 6. Shape, elevation, state layers

- Radius scale (Material 3 shape tokens [M3-spec]): `--r-xs:4px; --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:28px; --r-full:999px`. Chips 8; filled/tonal buttons pill; text fields 8; thumbnails 8; cards 12; bottom sheet and dialogs top/all 28; slider thumb and swatches full.
- **Nested radii are concentric: outer = inner + padding** (28 sheet with 16 padding holds 12 radius children). If padding exceeds 24px treat them as separate surfaces. [MIFB]
- Elevation: tonal surfaces (`s1` to `s4`) carry depth in dark; shadows only on floating things (sheet, menu, snackbar, dialog) using the layered values above. Do not use one soft grey shadow on everything. [M3 R1.8, UXPM elevation-consistent, FD]
- **State layers** (an overlay of `currentColor`): hover 8% (pointer devices only), focus 10%, pressed 10%, dragged 16% [M3-spec]; transition `opacity` 80ms. Disabled: 38% opacity + `disabled`/`aria-disabled` + no pressed feedback. Read-only is visibly different from disabled. [UXPM disabled-states, read-only-distinction]
- Focus ring: `:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}` (at least 2px, 3:1). Never `outline:none` without a replacement. [WIG, UXPM focus-appearance]
- Press feedback within 80 to 150ms on every tappable thing; on filled buttons and icon buttons also `transform:scale(0.96)` (never below 0.95, never on large surfaces like tool-strip items). Pressed state never changes layout bounds. [MIFB, UXPM pro-rules]

## 7. Icons

- **Inline SVG, one hand-authored set, no icon font, no emoji, no npm/CDN.** Put all icons in one hidden `<svg style="display:none">` sprite of `<symbol id="i-crop" viewBox="0 0 24 24">` inside `index.html` and use `<svg class="ic" aria-hidden="true"><use href="#i-crop"/></svg>`. Same-document `<use>` works offline under any origin; external sprite files can fail under `file://`. [VDF spacing-iconography.md, UXPM, ME]
- Style: 24x24 grid, `fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round`. Stroke 2px beside 500+ weight text (tool strip, top bar); 18px inline icons scaled from the 24 grid render about 1.5px, which suits 14px regular text. One stroke weight per surface. [MIFB icons.md]
- Sizes as tokens only: `--icon-sm:18px; --icon-md:24px; --icon-lg:32px`. [UXPM]
- One SVG, recolored by state through `currentColor` (default `--c-text-2`, selected `--c-accent`, disabled 38% opacity). **Outline by default, filled variant for the selected state** (tool strip, toggles); keep a `-fill` symbol per tool or give the main closed shape a `fill:currentColor` class. [MIFB, M3 R2.3]
- Decorative icons next to a visible label: `aria-hidden="true"`. Icon-only buttons: `aria-label` in Korean/English (section 10). Meaningful non-text icons need 3:1 contrast. [WIG, UXPM]
- Draw metaphors consistently: crop, rotate, flip, sliders (adjust), curve, sparkle (effects), layered circles (filters), text "T", sticker, brush, undo/redo arrows, split-view (compare), check (save/apply), X (close/cancel), reset arrow, eyedropper, zoom, more. Check each at 18px: simplify, no hairlines. Optically center asymmetric glyphs (play-like triangles, carets). [MIFB]
- If you vendor an open icon set (Lucide is ISC; Material Symbols is Apache-2.0), copy the SVG paths into the sprite and add a `NOTICE`; do not link or import it.

## 8. Motion

Principles: motion explains state or continuity; routine transitions 150 to 250ms; exit faster than enter (about 60 to 70% of enter); interruptible; compositor-only. [IMP operate/animate, UXPM, WIG]

```css
--dur-press:80ms; --dur-fast:150ms; --dur-base:200ms; --dur-slow:300ms;
--ease-standard:cubic-bezier(0.2,0,0,1);    /* state changes: chips, toggles, tool select  [M3-spec] */
--ease-out:cubic-bezier(0.05,0.7,0.1,1);    /* things arriving: sheet in, snackbar in      [M3-spec] */
--ease-in:cubic-bezier(0.3,0,0.8,0.15);     /* things leaving: sheet out, dialog out       [M3-spec] */
```

| Interaction | Duration | Easing | Property |
|---|---|---|---|
| Press state layer | 80ms | linear | `opacity` |
| Chip / segment / toggle / tool-pill change, icon swap | 150ms | standard | `background-color`, `opacity`, `transform` |
| Slider thumb grow (1.15) on drag, value bubble in | 150ms | out | `transform`, `opacity` |
| Sheet enter | 300ms | out | `transform: translateY(100%)` to `0` |
| Sheet exit | 200ms | in | `transform`, `opacity` |
| Tool-panel content swap inside the sheet | 150ms | standard | `opacity` cross-fade (no slide) |
| Canvas refit after sheet change, double-tap zoom | 250 to 300ms | standard | `transform` (FLIP) |
| Snackbar enter / exit | 200 / 150ms | out / in | `transform: translateY(8px)`, `opacity` |
| Dialog enter / exit | 200 / 150ms | out / in | `opacity`, `transform: scale(.96)` |
| Compare (show original) | **instant (0ms)** | none | swap source; fade the "Original" badge only |
| Pan, pinch, slider drag, sheet drag, handle drag | **none** (follow the finger via rAF) | n/a | settle with a 250ms ease-out on release |

- Only animate `transform`, `opacity` (and color for state). Never `transition: all`; never animate `width/height/top/left`. List properties explicitly. [WIG, MIFB]
- Use CSS transitions for interactive state (interruptible); keyframes only for one-shot sequences. `will-change: transform` only on the sheet during its animation. [MIFB]
- **No stagger, no entrance choreography** on routine UI (tool switches, chips, sliders) and none at app launch. Optional single authored moment: photo fade-in 200ms after load. [IMP, FD, MIFB]
- Motion is never the only feedback: every animated change has a static cue. [MIFB]
- `@media (prefers-reduced-motion: reduce)`: sheet/snackbar/dialog become 100ms opacity-only; no zoom/refit animation (jump); no indicator slide; keep color and opacity state changes. Also provide an in-app "Reduce motion" setting, because WebView may not mirror Android's "Remove animations": verify on device. [WIG, UXPM, ME]
- Interactive preview budget: respond to input within 100ms; throttle slider `input` events with `requestAnimationFrame`; render a reduced-resolution preview while dragging, full quality on release. [UXPM input-latency, main-thread-budget, ME]

## 9. Component specs

### 9.1 Slider (the signature control)

Use a native `<input type="range">` (TalkBack treats it as an adjustable control; arrow/volume-key and keyboard behavior come free), styled with CSS.

```css
.slider{ -webkit-appearance:none; appearance:none; width:100%; height:48px; margin:0;
  background:transparent; touch-action:pan-y; --from:0%; --to:50%; }
.slider::-webkit-slider-runnable-track{ height:4px; border-radius:2px;
  background:linear-gradient(to right,var(--c-track-off) 0 var(--from),var(--c-accent) var(--from) var(--to),var(--c-track-off) var(--to) 100%); }
.slider::-webkit-slider-thumb{ -webkit-appearance:none; width:24px; height:24px; margin-top:-10px; border-radius:50%;
  background:var(--c-accent); box-shadow:0 0 0 2px var(--c-s2);
  transition:transform var(--dur-fast) var(--ease-out); }
.slider:active::-webkit-slider-thumb{ transform:scale(1.15); }
.slider:focus-visible{ outline:2px solid var(--c-accent); outline-offset:2px; border-radius:8px; }
```

- Row: label (14/20, 500, `--c-text`) left, value (14/20, 500, tabular-nums, `--c-text-2`) right, slider below; row min-height 64; 16px side gutter; 12px between rows.
- **Bipolar adjustments (-100..+100)** fill from the center (`--from`/`--to` around 50%), a 2x10px center tick, a snap zone of about 2% around 0, and an optional haptic tick on entering the snap zone. Unipolar fills from the left.
- While dragging, show a value bubble 44px above the thumb (14px tabular, `--c-s4` background, radius 8, `aria-hidden`) so the finger does not hide the number; hide 400ms after release.
- **Alternatives to dragging** (required): tapping the value opens an inline numeric field (`inputmode="decimal"`, 16px font); `aria-valuetext` carries unit and sign ("Brightness plus 35"); header "Reset" text button restores defaults; double-tap on label or value resets that one parameter (also reachable via Reset). Native keyboard: arrows 1 step, PageUp/PageDown 10, Home/End. [WCAG 2.5.7, UXPM `dragging-alternative`]
- Update `aria-valuetext` live but announce on commit (`change`) to avoid chatty TalkBack output. [ME]
- Adjust panel, peek state (about 196px): header (title + Reset) 48, parameter chips 48, one active slider 64, padding 12. Expanded state shows the full labeled slider list (scrolls). This keeps the photo visible while editing. [ME, modeled on common mobile photo editors]

### 9.2 Chips (filter presets, aspect ratios, parameter selectors)

- 36px tall visual, 48px hit, radius 8, `padding:0 12px` (16px left when the check icon shows), 8px gap, label 14/20 500.
- Unselected: transparent, `1px solid var(--c-outline)`, text `--c-text-2`. Selected: `--c-accent-c` fill, `--c-on-accent-c` text, **leading 18px check icon**, no border. Pressed: 10% state layer. Disabled: 38%.
- Rows scroll horizontally with a visible peek (at least 24px) of the next chip and 16px edge fade masks; wrap instead when 6 or fewer. Wrap before shrinking labels; never hide values silently. [UXPM chip-collection-reflow, compact-label-overflow]
- Single-select groups use `role="radiogroup"` with real radio inputs (or `aria-pressed` toggle buttons for multi-select).
- Filter-preset thumbnails: 64x64 (radius 8, optional 1px edge outline) with a 12px label under; selected = 2px accent outline with 2px offset + check badge. Render previews once, small, off the main interaction path. [ME]

### 9.3 Segmented control (2 to 4 options: compare mode, RGB/R/G/B, crop free/fixed)

- Container 40px tall (48px hit via pseudo-element), `border:1px solid var(--c-outline)`, pill radius 20, segments divided by `--c-outline-v` hairlines (decorative only); label 14/20 500; min segment width 64.
- Selected segment: `--c-accent-c` fill + `--c-on-accent-c` text + leading 18px check (non-color cue). Implement with `<input type="radio">` + `<label>` inside `role="radiogroup"`; arrow keys move selection.
- Channel segments use letters (R, G, B), never color alone.

### 9.4 Buttons

| Kind | Height | Style | Use |
|---|---|---|---|
| Filled | 40 (48 hit), pill, `padding:0 24px`, min-width 72 | `--c-accent` / `--c-on-accent` | Save only: **one primary action per screen** |
| Tonal | 40 (48 hit), pill | `--c-accent-c` / `--c-on-accent-c` | Apply in dialogs/export |
| Outlined | 40 (48 hit), pill | `1px --c-outline`, text `--c-text` | secondary |
| Text | 48 min height, `padding:0 12px` | text `--c-accent` | Reset, Cancel, dialog actions |
| Icon | 40 visual, 48 hit, radius full | `currentColor` icon 24 | top bar, sheet header |
| Destructive | as tonal | `--c-danger-c` / `--c-on-danger-c` | Discard |

Label with a verb that names the result ("Save", "Apply", "Discard"); the same noun/verb through the whole flow (Save, then toast "Saved"). During work show a spinner but keep the label; do not pre-disable submit. [UXCOPY, FD writing, WIG]

### 9.5 Tool strip

- `role="tablist"` (`aria-label="Tools"`), each tool `role="tab"` `aria-selected`, roving `tabindex`, arrow keys move; selecting a tool shows its panel (`role="tabpanel"`, `aria-labelledby`).
- Item 76x72, icon 24 in a 56x32 pill (radius 16) on `--c-accent-c` when selected, label 12/16; selected adds accent filled icon and label weight 700 (do not rely on the pill: section 5).
- Scrolls horizontally, about 4.6 items visible at 360px (352px / 76px) so the overflow is evident; `overflow-x:auto; scrollbar-width:none; overscroll-behavior-x:contain; scroll-padding-inline:8px`; 16px edge fade masks; scroll the selected tool into view (smooth unless reduced motion). Always icon plus text label; never icon-only. [M3 R2.2, UXPM nav-label-icon]
- 3 to 5 top-level destinations is the Material rule for a bottom bar; here the strip lists tools (8 to 10), which is why it scrolls: keep tools in one flat row, no nesting, no second bar. [M3 R2.1, UXPM bottom-nav-top-level]

### 9.6 Top bar

- Left to right: Close (X), Undo, Redo, Compare, spacer, Save. 56px, bg `--c-bg`, no title (the photo is the focus), buttons 48 hit with 4px gaps.
- Undo/Redo disabled when the stack is empty (38% opacity, `disabled`). **Compare**: hold shows the original (pointerdown/up), and a plain click toggles it (`aria-pressed`), because TalkBack double-tap produces a click, not a hold. Show a small "Original" badge (14/500, `--c-s4`) at the canvas top-center while showing it.
- Close with unsaved edits opens a confirm dialog; with no edits it just exits. Never intercept Back for anything else. [M3 R2.12]

### 9.7 Bottom sheet

- Standard (non-modal) docked sheet for tool panels; modal sheet (scrim) only for supplementary flows such as export. [M3 R5.8]
- Visible drag handle 32x4 radius 2 `--c-outline`; tap on handle or header toggles peek/expanded as the non-drag alternative. Content scrolls (`overscroll-behavior:contain`) when it can exceed the max height. [M3 R5.9-5.10, WIG]
- Header 48: tool title (`title` role, `<h2>`), Reset (text button) and, for commit-style tools (crop, text, draw, sticker), Cancel (X) and Apply (check) icon buttons. Continuous tools (adjust, filters, effects) apply live; history is the top-bar Undo/Redo.
- The sheet drag starts only from handle/header, never from sliders or chip rows. Provide `Escape`/Back to close the sheet.

### 9.8 Per-tool notes

- **Crop:** aspect chips (Free, 1:1, 4:5, 3:4, 16:9, Original), rotate 90 left/right and flip buttons, a straighten slider (-45 to +45, bipolar). Corner brackets 24 long x 3 thick (white, 1px 40%-black shadow) with 48x48 zones; edge handles 48 zones; rule-of-thirds grid at 1px `rgba(255,255,255,.5)` while dragging; outside dimmed. **If the crop box is smaller than 3 x 48 = 144px, drop the edge handles and keep corners** (hit areas must not overlap). Alternatives to dragging: aspect presets, nudge buttons or arrow keys (1px, Shift 10px), numeric W/H/X/Y fields under an "Advanced" disclosure. Minimum crop size 32px of image.
- **Curves:** square plot 240px preferred (160px minimum, else switch to a modal sheet), channel segmented control (RGB, R, G, B with letters), histogram behind at 20% opacity, grid 4x4 in `--c-outline-v`. Points: 12px visible, 48px hit zones; tap adds, drag moves, drag out or "Delete point" button removes; the selected point shows numeric input/output and accepts arrow-key nudges (1, Shift 10). A bare `<canvas>` is invisible to TalkBack and the keyboard, so overlay one transparent focusable element per control point (`<button>` or `role="slider"`, positioned over the point, with an `aria-label` such as "Curve point 2, input 64, output 80") and keep the numeric fields as the primary alternative. [M3 6.5, A11Y]
- **Color picker (text, draw):** swatch row: 32px circles with 48 hit and 8 gaps; selected = 2px accent ring + 2px gap + check; "Custom" opens an HSV square plus hue/alpha sliders built from the same slider styles (track 12px for color sliders, thumb 24); eyedropper; 8 recent colors; hex field (16px). Never convey a color only by its swatch: expose its name or hex as `aria-label`.
- **Text:** the soft keyboard changes the viewport: use `visualViewport` or the shell's IME inset so the sheet stays above the keyboard; font chips use system families only; alignment as a segmented control; size via slider plus numeric field.
- **Sticker / Draw:** brush size and opacity sliders with a live preview dot; eraser and undo reachable without leaving the tool; for draw, use Pointer Events; once a stylus (`pointerType==='pen'`) is seen, ignore large-contact touch pointers (palm rejection), and keep 2-finger pinch/pan for navigation. Draw gestures are never the only way to undo.
- **Filters / Effects:** thumbnail chips (9.2) + one intensity slider; "None" first. Effects with several parameters follow the Adjust pattern.
- **Export (modal sheet):** format segmented (JPEG, PNG, WebP), quality slider, size chips, one filled "Save" button; result in a snackbar with a "View" action. Use the system Photo Picker for input and MediaStore for output (no storage permission at launch). [M3 anti-patterns]

### 9.9 Feedback, dialogs, empty/loading/error, microcopy

- Snackbar for transient feedback (auto-dismiss 4s; 8s when it has Undo; `role="status"`, never steals focus). Dialog only for decisions that must interrupt (discard unsaved edits); actions are text buttons, dismiss on the left, confirm on the right; titles are short questions. [M3 R5.11-5.16, UXPM toast-*]
- Loading: skeleton or stable placeholder (never a spinner floating over content); spinners only after about 150 to 300ms and shown at least 300 to 500ms; label ends with "…". Destructive actions require confirmation or Undo. Errors say what happened and how to fix it; no apologies. Empty state teaches the next step. [WIG, IMP, UXCOPY]
- Pick one Korean politeness register (suggested: 해요체) and keep it; same terms everywhere. [ME]

| Context | Korean | English fallback |
|---|---|---|
| Top bar buttons | 닫기 · 실행 취소 · 다시 실행 · 원본 보기 · 저장 | Close · Undo · Redo · View original · Save |
| Tools | 자르기 · 조정 · 곡선 · 필터 · 효과 · 텍스트 · 스티커 · 그리기 | Crop · Adjust · Curves · Filters · Effects · Text · Stickers · Draw |
| Adjust parameters | 밝기 · 대비 · 채도 · 색온도 · 색조 · 선명도 · 하이라이트 · 그림자 | Brightness · Contrast · Saturation · Warmth · Tint · Sharpness · Highlights · Shadows |
| Sheet actions | 초기화 · 취소 · 적용 | Reset · Cancel · Apply |
| Discard dialog | 편집 내용을 버릴까요? / 저장하지 않으면 변경 사항이 사라져요. / 계속 편집 · 버리기 | Discard edits? / Your changes will be lost if you don't save. / Keep editing · Discard |
| Saved toast | 갤러리에 저장했어요 · 보기 | Saved to gallery · View |
| Open error | 사진을 열 수 없어요. 다른 사진을 선택해 보세요. | Can't open this photo. Try another one. |
| Empty state | 편집할 사진을 선택하세요 · 사진 선택 | Choose a photo to edit · Choose photo |
| In progress | 저장 중… · 불러오는 중… | Saving… · Loading… |

## 10. Accessibility rules (WCAG 2.2 AA minimum)

1. **Contrast:** text 4.5:1 (large 3:1); control boundaries, icons, slider thumb, focus ring 3:1; verify both themes separately (tokens above already pass); pressed/focus/disabled states distinguishable in both themes. Measure the scrim composite behind sheets/dialogs. [UXPM, WIG]
2. **Targets:** 48px with 8px gaps, extended pseudo-element hit areas, no overlaps (section 3).
3. **Focus:** `:focus-visible` ring 2px accent + 2px offset on every control; sticky bars/sheets must not cover the focused control (`scroll-padding`); logical order = visual order; move focus into a dialog and return it on close; after Close of a sheet focus the tool tab. [WIG, UXPM focus-not-obscured]
4. **Names and roles:** native elements first (`<button>`, `<input type=range>`, radios, `<label>`); every icon-only button has `aria-label`; decorative SVG `aria-hidden="true"`; toggles `aria-pressed`; tools `role=tab` + `aria-selected`; panels `role=tabpanel`; toasts `role="status"`/`aria-live="polite"`; the canvas gets `role="img"` + `aria-label` ("편집 중인 사진") and a visually-hidden live region that announces commits ("자르기 적용됨"), not drag ticks. [WIG, A11Y, UXPM]
5. **No gesture-only actions:** every drag, swipe and pinch has a button or numeric alternative (slider value field, crop nudge + numeric, curves nudge, zoom chip, sheet handle tap). [WCAG 2.5.7, WIG, UXPM]
6. **Not by color alone:** check marks, filled icons, letters on channel segments, error icons plus text. [UXPM]
7. **Text scaling:** `rem` everywhere; `min-height` not `height`; verify 130% and 200%; no truncation of essential labels (wrap or ellipsis with the full text in the accessible name). Do not block zoom in the viewport meta (see section 11 for how the WebView handles canvas zoom). [M3 R4.4, WIG]
8. **Motion:** `prefers-reduced-motion` and the in-app setting; no autoplay; no flashing. [WIG]
9. **Forms:** visible labels (placeholder is not a label); input font at least 16px; correct `type`/`inputmode`; never block paste; errors inline next to the field plus a polite live region. [WIG, UXPM]
10. **Language:** `lang` on `<html>` follows the UI language; `translate="no"` on units/brand; `Intl` for numbers. [WIG]
11. **Reflow/orientation:** works at 320px width, in landscape, with no horizontal page scroll; no orientation lock. [UXPM, WCAG 1.3.4, 1.4.10]
12. **TalkBack:** test on a device (TalkBack reads the ARIA tree Chromium exposes). Test checklist: open image, switch tools, adjust a slider by swipe up/down, undo/redo, compare via double-tap, crop via presets and nudges, save, discard dialog. [A11Y mobile-accessibility.md]
13. Destructive actions need confirmation or Undo; Back never traps the user. [WIG, M3]

## 11. WebView and shell integration (the Java side, from the Material/WebView guidance)

- **Edge-to-edge and insets:** the shell calls `WindowCompat.setDecorFitsSystemWindows(window, false)` and pushes insets to CSS variables (`--safe-top`, `--safe-bottom`, `--safe-left`, `--safe-right`, `--ime`) on each `OnApplyWindowInsetsListener` call, because `env(safe-area-inset-*)` support inside WebView varies by version. In CSS: `padding-top:max(env(safe-area-inset-top,0px),var(--safe-top,0px))`. Add `viewport-fit=cover` to the viewport meta. [M3 R3.7, WIG, ME]
- **Back:** a native back callback calls a JS handler that closes menu, then sheet, then cancels an uncommitted tool, then shows the discard dialog if there are unsaved edits, otherwise lets the system finish the activity. Support predictive back by not swallowing the event needlessly. [M3 R2.10-2.13]
- **Dark theme:** the app ships its own dark theme; **turn off WebView algorithmic darkening** (`WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings,false)`) so the UI and the photo are never re-colored. Match status/navigation bar colors to `--c-bg` and set icon contrast by theme (bridge call). [ME]
- **Zoom:** the canvas implements its own pinch/double-tap, so disable WebView page zoom in the shell (`setSupportZoom(false)`, no built-in zoom controls) instead of putting `user-scalable=no` in the viewport meta; text scaling stays supported through `rem`. Trade-off to accept: low-vision users scale the UI with Android's font size / display size settings rather than page pinch, so test those. [WIG "respect zoom", ME]
- **Selection and callouts:** `-webkit-user-select:none; -webkit-touch-callout:none` on chrome/canvas and suppress the native long-press context menu in the shell. [ME]
- **Assets:** serve from `WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/...`) rather than `file://` so storage, `fetch` and ES modules behave; still fully offline. [ME]
- **Photos:** system Photo Picker for input, MediaStore for output; no `READ_EXTERNAL_STORAGE`; ask for nothing at launch. [M3 R9, anti-patterns]
- **Haptics (optional):** a bridge call for the slider center snap and tool selection; at most one per 100ms; never during continuous drag. [UXPM haptic-feedback]

## 12. Anti-patterns the skills warn about (do not ship these)

- Icons: emoji or Unicode glyphs as icons; mixed icon sets; mixed stroke widths; filled and outline mixed at the same level; raster icons; icon-only navigation; unlabeled icon buttons. [UXPM, WIG, IMP]
- Interaction: hover-only affordances (no hover on touch); gesture-only actions; hit areas below 48px or overlapping; tooltips as primary help; `outline:none` without a focus style; instant 0ms state changes (except Compare by design); blocking paste; `autofocus` on mobile; modal as a first thought. [WIG, UXPM, IMP, M3]
- Motion: `transition: all`; animating `width/height/top/left`; one duration for everything; stagger or entrance choreography on routine UI; bounce/elastic curves by reflex; press scale below 0.95; animations that cannot be interrupted; no reduced-motion path. [WIG, MIFB, UXPM, IMP]
- Type: text under 12px; fixed pixel heights that clip at large font scale; Inter-by-default or any webfont download; ALL-CAPS tracked labels; eyebrow labels over headings; gradient text; justified Hangul without `keep-all`; placeholder-only labels; `...` instead of `…`. [FD, IMP, UXPM, WIG]
- Color/surface: raw hex in components; pure `#000` chrome surfaces (canvas near-black is fine); inverted light theme as "dark mode"; tinted chrome that biases photo color; heavy accent on inactive states; low-contrast gray-on-gray; color as the only state cue; one identical soft shadow on every card; nested cards; glass/blur as decoration; hard offset shadows; colored left borders; sparkline/progress-ring decoration; monospace as a costume. [UXPM, FD, IMP, M3]
- Layout/system: `100vh` instead of `100dvh`; fixed bars hiding scroll content; content under system bars; invented controls for standard tasks (custom scrollbars, odd form controls); a bottom bar that changes by screen; mixing tab + sidebar + bottom nav at one level; edge-to-edge paragraphs on tablets; `user-scalable=no` in the viewport meta. [UXPM, WIG, M3, IMP]
- Craft: arbitrary spacing and radius values (use the tokens); equal radius on nested surfaces (use outer = inner + padding); geometric centering where optical centering is needed; fake elevation with borders. [MIFB, DS]

## 13. Where skill guidance assumed the network (and how it was adapted)

| Guidance | Dependency | Adaptation |
|---|---|---|
| web-design-guidelines SKILL.md fetches rules from raw.githubusercontent.com on each review | runtime fetch | rules vendored as `command.md` and `guidelines.md`; SKILL.md rewritten |
| WIG: preconnect to CDNs, preload fonts | CDN/webfonts | not applicable: no CDN; no webfont |
| ui-ux-pro-max: Python search CLI; typography.csv with Google Fonts imports; Phosphor/Lucide npm imports; GSAP presets; stack CSVs | exec, CDN, npm | scripts and CDN data not installed; Grep the CSVs; system fonts, inline SVG, CSS transitions |
| visual-design-foundations / design-system-patterns: Inter woff2, Tailwind config, React providers, Style Dictionary, Figma sync | npm/CDN/tooling | project notes added; use plain CSS custom properties |
| frontend-design: "choose distinctive typefaces" | implies webfonts | distinctiveness comes from the accent discipline, shape, icon drawing, the slider, and motion restraint; a Korean webfont is too heavy |
| make-interfaces-feel-better: `motion` / framer-motion; `oklch()` | npm; WebView 111+ | CSS transitions; hex tokens above |
| android-design-guidelines (Material 3): Dynamic Color, Material Theme Builder, Compose | platform/online tool | static light/dark token sets computed above; Dynamic Color not available to CSS |
| impeccable (not installed): launcher downloads a binary from GitHub Releases; font index | download + execute | excluded; only its text docs were read |
| Anthropic design plugin: Figma/Slack/Linear/Notion MCP connectors | remote MCP | only two skill texts installed (design-critique, ux-copy); no connectors |

## 14. Pre-delivery checklist (run before calling a screen done)

- [ ] Every interactive element 48x48 with 8px gaps; no overlapping hit areas.
- [ ] Only token values for color, spacing, radius, type, duration, easing; no raw hex or magic numbers in components.
- [ ] Dark and light both reviewed separately; contrast spot-checked; borders and states visible in both.
- [ ] No emoji icons; one icon set, one stroke weight; labels on all icon-only buttons.
- [ ] Every drag/pinch/swipe has a tap or numeric alternative.
- [ ] Tested at 320px, 360px, 412px, landscape, 130% and 200% font scale, with keyboard/TalkBack.
- [ ] Reduced motion honored; nothing animates layout properties; no `transition: all`.
- [ ] Safe areas respected; nothing hidden under system bars, the sheet, or the IME; Back works.
- [ ] Press feedback within 100ms; preview responds within 100ms while dragging.
- [ ] Korean strings short, polite and consistent; English fallback does not overflow.
- [ ] Review pass: `web-design-guidelines` (rules), `make-interfaces-feel-better` (quick mode), `ui-ux-pro-max/references/pro-rules.md` (pre-delivery checklist), `design-critique`.

---

## Appendix A: skills installed (`.claude/skills/<name>/`, each with `PROVENANCE_2026-11-14.md` and a LICENSE file)

| Skill | Source | License | Covers | Use for this app |
|---|---|---|---|---|
| web-design-guidelines | vercel-labs/agent-skills + vercel-labs/web-interface-guidelines (rules vendored; SKILL.md modified for offline) | MIT | touch, focus, forms, animation, safe areas, dark mode, i18n, anti-patterns | High |
| ui-ux-pro-max (trimmed, script-free) | nextlevelbuilder/ui-ux-pro-max-skill v2.15.0 | MIT | 120 UX rules, 32 app-interface rules, app pre-delivery checklist, palettes, styles, motion, icon metaphors | High |
| make-interfaces-feel-better | jakubkrehel/make-interfaces-feel-better | MIT | concentric radius, shadows, hit areas, icon stroke/state, press scale, interruptible motion | High |
| frontend-design | anthropics/skills (same file in claude-plugins-official) | Apache-2.0 | design process, restraint, template-default tells, UI copywriting | Medium |
| android-design-guidelines | ehmo/platform-design-skills (Material 3) | MIT | M3 color roles, type scale, sheets, chips, snackbars, Back, touch targets, anti-patterns | Medium |
| accessibility-compliance | wshobson/agents (ui-design) | MIT | WCAG 2.2, ARIA patterns, mobile/TalkBack | Medium |
| visual-design-foundations | wshobson/agents (ui-design) | MIT | type/spacing/color/icon systems | Medium-low |
| design-system-patterns | wshobson/agents (ui-design) | MIT | token tiers, CSS-variable theming | Low-medium |
| design-critique | anthropics/knowledge-work-plugins (design) | Apache-2.0 | structured self-review | Low |
| ux-copy | anthropics/knowledge-work-plugins (design) | Apache-2.0 | microcopy, errors, empty states | Low |

Excluded: **impeccable** (pbakaus/impeccable v4.9.1, Apache-2.0): its Setup step runs a launcher that downloads and executes a binary; text docs used for this brief only. Not relevant to an offline vanilla app: theme-factory, canvas-design, brand-guidelines (Anthropic's own brand), web-artifacts-builder (React/shadcn bundler), react-native/react skills, SwiftUI/iOS skills. Registry (Anthropic plugin directory) plugins could be listed but not installed from here (no install tool); several community plugins carry SessionStart/PreToolUse hooks and were not pulled in.

## Appendix B: upstream commits

anthropics/skills 2c5958ec · anthropics/knowledge-work-plugins e91a1345 · anthropics/claude-plugins-official b5b01ac4 · nextlevelbuilder/ui-ux-pro-max-skill 6ae86f61 · vercel-labs/agent-skills 1a2c79d4 · vercel-labs/web-interface-guidelines 434b7f91 · wshobson/agents 9c61ab24 · jakubkrehel/make-interfaces-feel-better 35545ea1 · ehmo/platform-design-skills dc2be825 · pbakaus/impeccable 1995764b (not installed). Full SHAs for installed skills are in each skill's PROVENANCE file. Full SHAs for the two upstreams that have no PROVENANCE file: anthropics/claude-plugins-official `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6` (frontend-design plugin v1.1.1, same SKILL.md as anthropics/skills); pbakaus/impeccable `1995764b4936f2bfbf4eb719cb37b384a45ceacb` (v4.9.1, Apache-2.0, not installed). Clones used for vetting lived in the session scratchpad (`.../scratchpad/skill_dl/`), outside the repo.
