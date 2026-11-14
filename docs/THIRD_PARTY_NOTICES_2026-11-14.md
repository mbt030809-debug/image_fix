# 서드파티 고지 (2026-11-14)

## 앱에 포함된 것
- **Lucide 아이콘** — ISC License — https://lucide.dev (`web/src/icons.js` 는 `lucide-static` 에서 필요한 아이콘만 추출해 생성)

  ISC License · Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
  Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.

- **번들 폰트 (SIL Open Font License 1.1)** — `web/public/fonts/<폰트>/LICENSE` 에 각 라이선스 원문 포함. @fontsource 패키지에서 woff2 만 복사.
  Black Han Sans(Zess Type), Jua(Woowa Brothers), Nanum Pen Script(Sandoll), Pacifico(Vernon Adams et al.), Bebas Neue(Dharma Type), Dancing Script(Impallari Type), Permanent Marker(Font Diner), Playfair Display(Claus Eggers Sørensen).
- 그 외 앱 코드는 외부 라이브러리 없이 직접 작성한 바닐라 JS / Java 입니다. UI 는 기기 시스템 폰트를 쓰고, 웹 화면은 네트워크 리소스를 사용하지 않습니다.
- **AI 수정(선택 기능)** 은 사용자가 입력한 API 키로 OpenAI Images API(또는 호환 서버)를 호출합니다. 앱에 포함된 서비스가 아니며, 이용 약관·사용 정책·요금은 해당 제공자 정책을 따릅니다. 자세한 데이터 흐름은 `docs/AI_EDIT_2026-11-14.md` 참고.

## 빌드 도구 (앱에 포함되지 않음)
- esbuild (MIT) — 웹 번들
- Android 플랫폼 클래스: `org.robolectric:android-all` (Apache-2.0, 컴파일 전용 android.jar 대용)
- R8/D8 (BSD-3), apksigner/aapt/zipalign (Apache-2.0, Ubuntu 패키지)

## 개발 중 사용한 디자인 스킬 (저장소 `.claude/skills/`)
각 폴더의 `PROVENANCE_2026-11-14.md` 에 출처 URL · 라이선스 · 커밋이 기록돼 있습니다 (MIT / Apache-2.0).
