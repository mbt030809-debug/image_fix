# 평가용 맵 생성(개발 전용): 사진마다 ① 앱 모델(u2netp fp32/int8) 320px 확률맵 ② 기준(isnet-general-use 1024px) 확률맵을 만든다.
# 사용: python3 make_maps.py <사진폴더> <모델폴더> <출력폴더>
import sys, os, glob, time, numpy as np, onnxruntime as ort
from PIL import Image, ImageOps
src, mdl, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
def sess(p): 
    o = ort.SessionOptions(); o.intra_op_num_threads = 1
    return ort.InferenceSession(p, o, providers=['CPUExecutionProvider'])
def run(s, im, size, mean, std):
    x = np.asarray(im.resize((size, size), Image.BILINEAR), dtype=np.float32)
    x = x / max(x.max(), 1e-6); x = (x - mean) / std
    t = time.time(); o = s.run(None, {s.get_inputs()[0].name: x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
    dt = time.time() - t
    return (o - o.min()) / max(o.max() - o.min(), 1e-6), dt
mean_u, std_u = np.array([.485, .456, .406]), np.array([.229, .224, .225])
S = {'fp32': sess(f'{mdl}/u2netp.onnx'), 'q8': sess(f'{mdl}/u2netp_q8s.onnx') if os.path.exists(f'{mdl}/u2netp_q8s.onnx') else None, 'gt': sess(f'{mdl}/isnet.onnx')}
for f in sorted(glob.glob(f'{src}/*.jpg')):
    n = os.path.basename(f)[:-4]; im = ImageOps.exif_transpose(Image.open(f)).convert('RGB'); im.save(f'{out}/{n}.png'); open(f'{out}/{n}.rgba','wb').write(np.asarray(im.convert('RGBA')).tobytes()); open(f'{out}/{n}.size','w').write(f'{im.size[0]} {im.size[1]}')
    for k in ('fp32', 'q8'):
        if S[k] is None: continue
        m, dt = run(S[k], im, 320, mean_u, std_u); m.astype(np.float32).tofile(f'{out}/{n}.{k}.f32'); print(n, k, f'{dt*1000:.0f}ms (python 1 thread)')
    tp = f'{src}/{n}.truth.f32'
    if os.path.exists(tp): np.fromfile(tp, dtype=np.float32).tofile(f'{out}/{n}.gt.f32'); continue  # 합성 사진: 정답을 이미 알고 있다
    g, dt = run(S['gt'], im, 1024, np.array([.485, .456, .406]), np.array([1, 1, 1])); g.astype(np.float32).tofile(f'{out}/{n}.gt.f32'); print(n, 'gt', f'{dt:.1f}s', im.size)
