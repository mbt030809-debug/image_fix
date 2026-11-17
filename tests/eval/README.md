# 경계 정밀화 평가 (개발 전용)
사진은 저장소에 넣지 않는다(개인 사진 포함 가능). 사용법:
1. `pip install onnxruntime onnx pillow opencv-python-headless numpy`
2. 사진 폴더 `set/`(jpg), 모델 폴더 `models/`(`u2netp.onnx` = `web/public/models/u2netp.onnx`, `isnet.onnx` = rembg 릴리스의 isnet-general-use)
3. `python3 make_maps.py set models maps` — 앱 모델(fp32) 확률맵과 기준(isnet) 맵 생성. 합성 사진은 `{이름}.truth.f32`(1024×1024 float32)가 있으면 그것을 정답으로 쓴다.
4. `node eval.mjs maps out` — 방식별 IoU / 경계 F-score / 거리 오차 / 시간 표 + `out/*.u8` 마스크
5. `python3 montage2.py maps out show.png 사진이름…` — 입력 | 현재 | 새 방식 | 정답 비교 이미지
(`LR=0.08 node eval.mjs …` 로 올가미를 더 넉넉하게 시뮬레이션)
