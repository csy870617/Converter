# 충실도 보정(역투영)을 모델 안에 넣는다: 결과를 원본 크기로 줄였을 때 원본과 같아지도록 고친다.
import torch, torch.nn as nn, torch.nn.functional as F, numpy as np
def cubic(x, a):
    x = np.abs(x)
    return np.where(x <= 1, (a + 2) * x**3 - (a + 3) * x**2 + 1, np.where(x < 2, a * x**3 - 5 * a * x**2 + 8 * a * x - 4 * a, 0))
KD = cubic((np.arange(16) - 7.5) / 4, -0.5); KD = KD / KD.sum()          # 4배 축소 (안티앨리어싱 바이큐빅)
KU = cubic((np.arange(16) - 7.5) / 4, -0.5)                                # 4배 확대 (바이큐빅)
G = np.exp(-np.arange(-1, 2) ** 2 / (2 * 0.5 ** 2)); G = G / G.sum()       # 약한 흐림 (sigma 0.5)
class Fidelity(nn.Module):
    def __init__(s, sr, iters=3):
        super().__init__(); s.sr = sr; s.iters = iters
        t = lambda k: torch.tensor(k, dtype=torch.float32)
        s.register_buffer('dh', t(KD).view(1, 1, 1, 16).repeat(3, 1, 1, 1)); s.register_buffer('dv', t(KD).view(1, 1, 16, 1).repeat(3, 1, 1, 1))
        s.register_buffer('uh', t(KU).view(1, 1, 1, 16).repeat(3, 1, 1, 1)); s.register_buffer('uv', t(KU).view(1, 1, 16, 1).repeat(3, 1, 1, 1))
        s.register_buffer('gh', t(G).view(1, 1, 1, 3).repeat(3, 1, 1, 1)); s.register_buffer('gv', t(G).view(1, 1, 3, 1).repeat(3, 1, 1, 1))
    def down(s, x):
        x = F.pad(x, (6, 6, 6, 6), mode='replicate')
        return F.conv2d(F.conv2d(x, s.dh, stride=(1, 4), groups=3), s.dv, stride=(4, 1), groups=3)
    def up(s, x):
        x = F.pad(x, (2, 2, 2, 2), mode='replicate')
        y = F.conv_transpose2d(F.conv_transpose2d(x, s.uh, stride=(1, 4), groups=3), s.uv, stride=(4, 1), groups=3)
        return y[:, :, 14:-14, 14:-14]
    def blur(s, x):
        x = F.pad(x, (1, 1, 1, 1), mode='replicate')
        return F.conv2d(F.conv2d(x, s.gh, groups=3), s.gv, groups=3)
    def gauss(s, x, sigma):
        # sigma(4배 결과 기준 화소)를 입력으로 받아 그때그때 가우스 흐림 필터를 만든다
        t = torch.arange(-12, 13, dtype=x.dtype, device=x.device)
        k = torch.exp(-t * t / (2 * sigma * sigma)); k = k / k.sum()
        x = F.pad(x, (12, 12, 12, 12), mode='replicate')
        x = F.conv2d(x, k.view(1, 1, 1, 25).repeat(3, 1, 1, 1), groups=3)
        return F.conv2d(x, k.view(1, 1, 25, 1).repeat(3, 1, 1, 1), groups=3)
    def forward(s, x, core, soft, sharp, radius):
        # core: 이 값보다 작은 차이(잡음·압축 흔적)는 무시, soft: 1이면 비교 전에 살짝 흐리게(압축된 원본용)
        # sharp: '강하게' 모드의 윤곽 강조 세기(0이면 끔), radius: 강조 반경(4배 결과 기준 화소)
        y = s.sr(x)
        tgt = x + soft * (s.blur(x) - x)
        for _ in range(s.iters):
            d = s.down(y); d = d + soft * (s.blur(d) - d)
            r = tgt - d
            r = torch.sign(r) * F.relu(r.abs() - core)
            y = y + s.up(r)
        y = y.clamp(0, 1)
        return (y + sharp * (y - s.gauss(y, radius))).clamp(0, 1)
