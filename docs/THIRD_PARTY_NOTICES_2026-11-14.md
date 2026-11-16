# 서드파티 고지 (2026-11-14)

## 앱에 포함된 것
- **Lucide 아이콘** — ISC License — https://lucide.dev (`web/src/icons.js` 는 `lucide-static` 에서 필요한 아이콘만 추출해 생성)

  ISC License · Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
  Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.

- **번들 폰트 (SIL Open Font License 1.1)** — `web/public/fonts/<폰트>/LICENSE` 에 각 라이선스 원문 포함. @fontsource 패키지에서 woff2 만 복사.
  Black Han Sans(Zess Type), Jua(Woowa Brothers), Nanum Pen Script(Sandoll), Pacifico(Vernon Adams et al.), Bebas Neue(Dharma Type), Dancing Script(Impallari Type), Permanent Marker(Font Diner), Playfair Display(Claus Eggers Sørensen).
- **인물 분리 모델 (v2.2.0~, 앱에 포함·기기에서 실행·네트워크 없음)**
  - **U²-Net-P** (`web/public/models/u2netp.onnx`, 4.5MB) — Xuebin Qin et al., *U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection*, Apache-2.0. ONNX 변환본은 rembg 프로젝트 릴리스(`danielgatis/rembg` v0.0.0, MIT)에서 받았다. sha256 `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
  - **ONNX Runtime Web 1.19.2** (`ort/ort.wasm.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`) — Microsoft, MIT. 단일 스레드 wasm 으로만 실행.
  - 테스트 사진 `tests/fixtures/person_real.jpg` 는 rembg 저장소 `examples/girl-1.jpg` (앱에는 포함되지 않음).
- 그 외 앱 코드는 외부 라이브러리 없이 직접 작성한 바닐라 JS / Java 입니다. UI 는 기기 시스템 폰트를 쓰고, 웹 화면은 네트워크 리소스를 사용하지 않습니다.
- **AI 기능(선택 기능, v1.5.0~)** 은 **Cloudflare Workers AI**(API 토큰 + 계정 ID) · **ModelScope API-Inference**(액세스 토큰) · **Google Gemini API**(API 키) · **fal.ai**(API 키) 중 사용자가 고른 제공자를 호출합니다(OpenAI·OpenRouter·Pollinations 는 삭제). 앱에 포함된 서비스가 아니며, 이용 약관·사용 정책·요금·무료 한도·데이터 사용 정책은 각 제공자(그리고 그 서비스가 쓰는 모델 제공사 — FLUX: Black Forest Labs, Qwen-Image: Alibaba, Gemini: Google 등)의 정책을 따릅니다. 이 앱이 만든 결과물의 권리·사용 조건도 해당 서비스·모델의 약관을 확인하세요. 자세한 데이터 흐름은 `docs/AI_EDIT_2026-11-14.md` 참고.

## 빌드 도구 (앱에 포함되지 않음)
- esbuild (MIT) — 웹 번들
- Android 플랫폼 클래스: `org.robolectric:android-all` (Apache-2.0, 컴파일 전용 android.jar 대용)
- R8/D8 (BSD-3), apksigner/aapt/zipalign (Apache-2.0, Ubuntu 패키지)

## 개발 중 사용한 디자인 스킬 (저장소 `.claude/skills/`)
각 폴더의 `PROVENANCE_2026-11-14.md` 에 출처 URL · 라이선스 · 커밋이 기록돼 있습니다 (MIT / Apache-2.0).
