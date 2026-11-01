# 사진용 모델과 그림·애니메이션용 모델을 사진·그림·선 그림·글자에서 비교한다 (모두 충실도 보정을 씌운 상태).
#   .venv/bin/pip install torch onnx onnxruntime scikit-image lpips  (build.py·evaluate.py 준비물)
#   .venv/bin/python scripts/model/evaluate_art.py
# 그림: Pepper&Carrot (David Revoy, CC BY 4.0) 원화. 선 그림·글자: 이 스크립트가 크게 그린 뒤 줄여 만든다.
import os, io, glob, tarfile, urllib.request, numpy as np, torch, torch.nn.functional as F, lpips
from PIL import Image, ImageDraw, ImageFont
from skimage.metrics import structural_similarity as ssim
from arch import load, fetch, CACHE
from fidelity import Fidelity
torch.set_num_threads(os.cpu_count())
here = os.path.dirname(__file__)
C = 192  # 192×192 조각을 1/4로 줄인 뒤 다시 4배로 키워 원본과 비교
rng = np.random.default_rng(0)

def photos():
    data = os.path.join(CACHE, 'bench')
    for s in ('Set5', 'Set14', 'Urban100'):
        if not os.path.isdir(os.path.join(data, f'{s}_HR')):
            with tarfile.open(fetch(f'https://huggingface.co/datasets/eugenesiow/{s}/resolve/main/data/{s}_HR.tar.gz')) as t: t.extractall(data)
    files = sorted(glob.glob(f'{data}/Set5_HR/*.png')) + sorted(glob.glob(f'{data}/Set14_HR/*.png')) + sorted(glob.glob(f'{data}/Urban100_HR/*.png'))[:12]
    for f in files:
        im = Image.open(f).convert('RGB'); cx, cy = im.width // 2, im.height // 2
        yield im.crop((cx - C // 2, cy - C // 2, cx + C // 2, cy + C // 2))

EPISODES = ['ep01_Potion-of-Flight', 'ep05_Special-holiday-episode', 'ep10_Summer-Special', 'ep15_The-Crystal-Ball',
            'ep20_The-Picnic', 'ep25_There-are-no-Shortcuts', 'ep30_Need-a-Hug', 'ep35_The-Reflection', 'ep38_The-Healer', 'ep40_The-Weight-of-Expectations']
def art():
    """그림: 회차마다 첫 쪽에서 무늬가 많은 곳 3군데. 원화(약 2500×3500)를 절반으로 줄여 JPEG 흔적을 없앤 뒤 자른다."""
    d = os.path.join(CACHE, 'art'); os.makedirs(d, exist_ok=True)
    for ep in EPISODES:
        n = int(ep[2:4])
        path = os.path.join(d, f'{ep}.jpg')
        if not os.path.exists(path):
            urllib.request.urlretrieve(f'https://www.peppercarrot.com/0_sources/{ep}/hi-res/gfx-only/gfx_Pepper-and-Carrot_by-David-Revoy_E{n:02d}P01.jpg', path)
        im = Image.open(path).convert('RGB'); im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
        g = np.asarray(im.convert('L'), np.float32)
        picked = 0
        for _ in range(400):
            x, y = int(rng.integers(0, im.width - C)), int(rng.integers(0, im.height - C))
            if g[y:y + C, x:x + C].std() > 38:
                yield im.crop((x, y, x + C, y + C)); picked += 1
                if picked == 3: break

def lineart():
    """선 그림: 검은 테두리가 있는 단색 도형 (만화·아이콘·로고 같은 그림). 4배 크게 그린 뒤 줄여 매끈하게."""
    for _ in range(16):
        big = Image.new('RGB', (C * 4, C * 4), tuple(int(v) for v in rng.integers(200, 256, 3)))
        dr = ImageDraw.Draw(big)
        for _ in range(int(rng.integers(4, 8))):
            x0, y0 = rng.integers(-100, C * 4 - 100, 2); w, h = rng.integers(120, 460, 2)
            fill = tuple(int(v) for v in rng.integers(0, 256, 3)); width = int(rng.integers(8, 20))
            box = [int(x0), int(y0), int(x0 + w), int(y0 + h)]
            if rng.random() < 0.5: dr.ellipse(box, fill=fill, outline=(20, 20, 20), width=width)
            else:
                pts = [(int(x0 + rng.integers(0, w)), int(y0 + rng.integers(0, h))) for _ in range(int(rng.integers(3, 6)))]
                dr.polygon(pts, fill=fill, outline=(20, 20, 20), width=width)
        yield big.resize((C, C), Image.LANCZOS)

def text():
    """글자: 한글·영문·숫자가 섞인 화면 캡처 같은 그림 (나눔고딕)."""
    font_path = os.path.join(here, '..', '..', 'public', 'fonts', 'NanumGothic-Regular.ttf')
    lines = ['파일 변환기 화질 개선 시험 2026', 'Upscale TEST 1234 abcdefg', '사진·동영상·문서를 바꾸고 줄이기', '가나다라마바사 ABC xyz 0.95%']
    # 줄였을 때 글자 높이 약 10~14화소 (작은 화면 캡처에서 흔한 크기)
    for i in range(8):
        big = Image.new('RGB', (C * 4, C * 4), (255, 255, 255) if i % 2 == 0 else (34, 37, 44))
        dr = ImageDraw.Draw(big); size = 160 + 20 * (i % 4)
        font = ImageFont.truetype(font_path, size)
        for k in range(4):
            dr.text((16, 8 + k * int(size * 1.3)), lines[(i + k) % 4], font=font, fill=(25, 25, 25) if i % 2 == 0 else (235, 235, 235))
        yield big.resize((C, C), Image.LANCZOS)

def degrade(hr, kind):
    lr = hr.resize((C // 4, C // 4), Image.BICUBIC)
    if kind == 'jpeg':
        b = io.BytesIO(); lr.save(b, 'JPEG', quality=75); lr = Image.open(b).convert('RGB')
    return lr
t = lambda im: torch.from_numpy(np.asarray(im, np.float32) / 255).permute(2, 0, 1)[None]
down = lambda x: F.interpolate(x, scale_factor=0.25, mode='bicubic', antialias=True)
def Y(x): x = x[0].numpy(); return 16 + 65.481 * x[0] + 128.553 * x[1] + 24.966 * x[2]
def psnr(a, b, border=4):
    a, b = Y(a)[border:-border, border:-border], Y(b)[border:-border, border:-border]
    return 10 * np.log10(255 ** 2 / np.mean((a - b) ** 2))

if __name__ == '__main__':
    lp = lpips.LPIPS(net='alex', verbose=False)
    models = {name: Fidelity(load(name)).eval() for name in ('wdn', 'anime', 'anime6b')}
    label = {'wdn': '사진용(지금)', 'anime': '그림용 가벼운(anime v3)', 'anime6b': '그림용 무거운(anime 6B)'}
    sets = {'사진': list(photos()), '그림': list(art()), '선 그림': list(lineart()), '글자': list(text())}
    print(f'조각 수: ' + ', '.join(f'{k} {len(v)}' for k, v in sets.items()))
    print(f'\n{"종류":6}{"원본 상태":8}{"방법":24}{"PSNR":>7}{"SSIM":>8}{"LPIPS":>8}{"일치":>7}')
    for sname, crops in sets.items():
        for kind in ('clean', 'jpeg'):
            p = (0., 0.) if kind == 'clean' else (0.015, 1.)  # 화면과 같게: 무손실은 그대로, JPEG은 작은 차이를 무시
            res = {}
            for hr in crops:
                H, L = t(hr), t(degrade(hr, kind))
                outs = {'단순 확대(바이큐빅)': F.interpolate(L, scale_factor=4, mode='bicubic')}
                with torch.no_grad():
                    for name, m in models.items():
                        outs[label[name]] = m(L, torch.tensor([p[0]]), torch.tensor([p[1]]), torch.tensor([0.]), torch.tensor([1.]))
                for k, sr in outs.items():
                    sr = sr.clamp(0, 1); y, g = Y(sr), Y(H)
                    res.setdefault(k, []).append([psnr(sr, H), ssim(g[4:-4, 4:-4], y[4:-4, 4:-4], data_range=255),
                                                  lp(sr * 2 - 1, H * 2 - 1).item(), psnr(down(sr), down(H), 1)])
            for k, v in res.items():
                a = np.mean(v, 0); print(f'{sname:6}{kind:8}{k:24}{a[0]:7.2f}{a[1]:8.4f}{a[2]:8.4f}{a[3]:7.1f}')
