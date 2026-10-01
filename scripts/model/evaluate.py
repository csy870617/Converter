# 기존 모델과 새 모델의 화질·충실도를 표준 초해상도 시험 사진(Set5, Set14, Urban100 12장)으로 비교한다.
#   .venv/bin/pip install scikit-image lpips torchvision  (build.py 준비물에 더해)
#   .venv/bin/python scripts/model/evaluate.py
import os, io, glob, tarfile, numpy as np, torch, torch.nn.functional as F, onnxruntime as ort, lpips
from PIL import Image, ImageFilter
from skimage.metrics import structural_similarity as ssim
from arch import load, fetch
torch.set_num_threads(os.cpu_count())
here = os.path.dirname(__file__)
data = os.path.join(here, '.cache', 'bench')
for s in ('Set5', 'Set14', 'Urban100'):
    if not os.path.isdir(os.path.join(data, f'{s}_HR')):
        with tarfile.open(fetch(f'https://huggingface.co/datasets/eugenesiow/{s}/resolve/main/data/{s}_HR.tar.gz')) as t: t.extractall(data)
files = sorted(glob.glob(f'{data}/Set5_HR/*.png')) + sorted(glob.glob(f'{data}/Set14_HR/*.png')) + sorted(glob.glob(f'{data}/Urban100_HR/*.png'))[:12]
C = 192  # 가운데 192×192를 잘라 1/4로 줄인 뒤 다시 4배로 키워 원본과 비교

def degrade(hr, kind):
    """clean: 깨끗하게 줄인 사진, jpeg: 웹에서 흔한 JPEG(품질 70), hard: 흐림+잡음+강한 JPEG(품질 45)"""
    if kind == 'hard': hr = hr.filter(ImageFilter.GaussianBlur(1.6))
    lr = hr.resize((C // 4, C // 4), Image.BICUBIC)
    if kind == 'hard':
        a = np.asarray(lr, np.float32) + np.random.default_rng(0).normal(0, 6, (C // 4, C // 4, 3))
        lr = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if kind != 'clean':
        b = io.BytesIO(); lr.save(b, 'JPEG', quality=70 if kind == 'jpeg' else 45); lr = Image.open(b).convert('RGB')
    return lr
t = lambda im: torch.from_numpy(np.asarray(im, np.float32) / 255).permute(2, 0, 1)[None]
down = lambda x: F.interpolate(x, scale_factor=0.25, mode='bicubic', antialias=True)
def Y(x): x = x[0].numpy(); return 16 + 65.481 * x[0] + 128.553 * x[1] + 24.966 * x[2]
def psnr(a, b, border=4):
    a, b = Y(a)[border:-border, border:-border], Y(b)[border:-border, border:-border]
    return 10 * np.log10(255 ** 2 / np.mean((a - b) ** 2))
lp = lpips.LPIPS(net='alex', verbose=False)
S = ort.InferenceSession(os.path.join(here, '..', '..', 'public', 'models', 'fidelity-x4.onnx'))
def new(L, core, soft):
    f = {'input': L.numpy(), 'core': np.array([core], np.float32), 'soft': np.array([soft], np.float32),
         'sharp': np.array([0], np.float32), 'radius': np.array([1], np.float32)}
    return torch.from_numpy(S.run(None, f)[0])
old = {'기존 동영상용(general)': load('general'), '기존 사진용(x4plus)': load('x4plus')}
print('PSNR·SSIM: 원본과 얼마나 같은지(높을수록 좋음) / LPIPS: 사람 눈에 얼마나 달라 보이는지(낮을수록 좋음)')
print('일치: 결과를 다시 줄였을 때 원본과 같은 정도(높을수록 왜곡이 적음)\n')
print(f'{"원본 상태":8}{"방법":26}{"PSNR":>7}{"SSIM":>8}{"LPIPS":>8}{"일치":>7}')
for kind in ('clean', 'jpeg', 'hard'):
    res = {}
    for f in files:
        im = Image.open(f).convert('RGB'); cx, cy = im.width // 2, im.height // 2
        hr = im.crop((cx - C // 2, cy - C // 2, cx + C // 2, cy + C // 2)); H, L = t(hr), t(degrade(hr, kind))
        with torch.no_grad():
            outs = {'단순 확대(바이큐빅)': F.interpolate(L, scale_factor=4, mode='bicubic')}
            outs.update({k: m(L) for k, m in old.items()})
        outs['새 모델' + ('(무손실 원본용)' if kind == 'clean' else '(손실 압축 원본용)')] = new(L, *((0, 0) if kind == 'clean' else (0.015, 1)))
        for k, sr in outs.items():
            sr = sr.clamp(0, 1); y, g = Y(sr), Y(H)
            res.setdefault(k, []).append([psnr(sr, H), ssim(g[4:-4, 4:-4], y[4:-4, 4:-4], data_range=255),
                                          lp(sr * 2 - 1, H * 2 - 1).item(), psnr(down(sr), down(H), 1)])
    for k, v in res.items():
        a = np.mean(v, 0); print(f'{kind:8}{k:26}{a[0]:7.2f}{a[1]:8.4f}{a[2]:8.4f}{a[3]:7.1f}')
