# 무료로 쓸 수 있는 이미지 생성 모델 조사 (2026-11-15)

> 이 환경에서는 YouTube 영상을 직접 볼 수 없어 **웹 검색 결과(영상 제목·설명 포함)와 공식 문서/포럼 요약**으로 정리했다. 무료 조건은 자주 바뀌고 출처 일부는 업체 블로그라서, 쓰기 전에 각 서비스의 현재 약관·요금 페이지를 확인할 것.

## 결론
- **유튜브에서 가장 많이 소개되는 무료 이미지 생성 API = Cloudflare Workers AI** (영상 대부분이 `FLUX.1 schnell` 로 문구→이미지). → 앱에 반영했다.
- **Gemini API(나노바나나 계열) 이미지 모델은 무료 쿼터가 0** 이라는 보고가 다수(포럼 `limit: 0`, 2026-01 기준). 유튜브의 "나노바나나 무료"는 대개 **AI Studio/Gemini 앱 화면**이지 API 가 아니다. → 제외.
- 나머지(Hugging Face·Stability·Leonardo·Replicate)는 **체험 크레딧이거나 유료**.

## 비교
| 서비스 | 무료 조건 | 사진 입력(편집) | 앱 반영 |
|---|---|---|---|
| **Cloudflare Workers AI** | 무료 계정 **하루 10,000 Neurons**(UTC 자정 초기화), 카드 불필요 | FLUX.1 schnell = 문구만(생성) · FLUX.2 dev/klein = 사진+문구(편집, 무료 플랜 제공 여부 미확인) · SD1.5 img2img/inpainting | **홈 "AI로 이미지 만들기"**(schnell) · **영역 "문구로 채우기"**(schnell) · **영역 편집**(FLUX.2) |
| **OpenRouter `:free`** | 카드 없이 `:free` 모델, 일일 한도. **모델이 수시로 바뀜** | 모델별(목록에서 "이미지 입력" 가능한 무료 모델만 자동 선택) | **영역 편집**(자동 탐색) |
| Gemini API (Nano Banana 등) | **무료 쿼터 0 보고**(일부 블로그는 500/일 주장 — 상충, 미확인) | 사진+문구(편집 우수) | 제외 |
| Hugging Face Inference Providers | 무료 사용자 크레딧이 **폐지됐다는 보고**(2026-10, 공식 미확인) | 모델별 | 제외 |
| Stability AI | 신규 25 크레딧(체험) | 인페인팅 등 | 제외 |
| Leonardo API / Replicate | $5 가입 크레딧 / 선불 | 모델별 | 제외 |
| Puter.js | 개발자 무료("사용자 지불" 방식) | — | 외부 스크립트 로드가 필요해 앱의 보안 모델(CSP)과 맞지 않아 제외 |
| Zhipu CogView-3-Flash | 무료라는 보고(재판매 경유 언급) | 문구만 | 미확인 |

## 앱에 반영한 것 (v1.3.0)
- **홈 "AI로 이미지 만들기"**: 문구 → (한국어면 영어로 번역) → FLUX.1 schnell → 결과를 바로 편집기로 열기. **사진은 보내지 않는다.**
- **영역 편집 "문구로 채우기"**(Cloudflare): 선택 안쪽을 새로 그린 그림으로 채운다(하늘·잔디·물결·벽 같은 내용에 적합). 사진은 보내지 않고, 색 보정은 끈다.
- **한국어 → 영어 번역**(Cloudflare `m2m100`, best-effort): FLUX 는 영어 문구에서 훨씬 잘 그린다. 번역이 안 되면 원문으로 진행한다.
- OpenAI(유료)도 같은 화면에서 `gpt-image` 로 새 이미지를 만들 수 있다.

## 확인한 영상 (제목/설명만 확인, 직접 시청 못 함)
- [Create an Unlimited AI Image Generator for FREE (Cloudflare Workers AI)](https://www.youtube.com/watch?v=vY7TJ-LeZ70)
- [Free AI Image API with Cloudflare](https://www.youtube.com/watch?v=4l1vynukmlE)
- [Use Cloudflare Workers to Generated Unlimited Free AI Generated Images](https://www.youtube.com/watch?v=ddqqZWXqLvw)
- [How to create free AI images generator API using CloudFlare workers](https://www.youtube.com/watch?v=5dmyPqw_jGE)
- [50줄 코드로 Cloudflare 무료 AI 생성+인식 API (중국어)](https://www.youtube.com/watch?v=VmOfoXWOTM0)
- (영상 하나는 "하루 약 1,000장" 이라고 주장하지만 제작자 주장이다. 실제 한도는 Neurons 기준이라 모델·크기에 따라 다르다.)

## 한계 / 미검증
- 실제 키로 호출해 보지 못했다(공식 문서·API 접속 불가, 모의 서버로만 검증). 요청·응답 형식은 검색으로 확인한 공개 자료 기준이다.
- **FLUX.1 schnell 응답 형식**: JSON(`result.image` base64)과 바이너리 이미지 두 가지를 모두 받도록 처리했다. 요청은 가장 단순한 `{prompt}` 만 보낸다(`steps` 등은 보내지 않음).
- **m2m100 언어 코드**(`ko`→`en`): 검색 결과의 예시는 영어→프랑스어뿐이라 한국어 코드는 미확인이다. 실패하면 원문으로 보낸다.
- Cloudflare 는 2026-07 부터 일부 모델(Kimi·GLM 등 텍스트 모델)을 무료 플랜에서 막았다(403/5035). 이미지 모델이 해당되는지는 확인하지 못했다.

## 출처
- Cloudflare: [요금](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [오류 코드](https://developers.cloudflare.com/workers-ai/platform/errors) · [일부 모델 유료 전환 공지](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/) · [FLUX.2 소개](https://blog.cloudflare.com/flux-2-workers-ai)
- Gemini 무료 쿼터: [Google AI 포럼(무료 티어 이미지 생성)](https://discuss.ai.google.dev/t/free-tier-api-image-generation/177423) · [limit: 0 보고](https://discuss.ai.google.dev/t/bug-paid-tier-1-account-getting-free-tier-requests-limit-0-on-image-generation-models-gemini-2-5-flash-image-gemini-3-pro-image-preview/123906) · [나노 바나나 API 가격(무료 티어 없음)](https://wikidocs.net/blog/@openwiki/32916/)
- OpenRouter: [이미지 모델 목록](https://openrouter.ai/collections/image-models)
- Hugging Face: [요금 문서](https://huggingface.co/docs/inference-providers/pricing) · [무료 크레딧 폐지 보고](https://www.usagepricing.com/blueprint/activity/hugging-face-2026-10-15-free-inference-credits-removed)
