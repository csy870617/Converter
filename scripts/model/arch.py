# Real-ESRGAN 신경망 구조 (https://github.com/xinntao/Real-ESRGAN, BSD-3-Clause)
import torch, torch.nn as nn, torch.nn.functional as F
class SRVGGNetCompact(nn.Module):
    def __init__(s, num_feat=64, num_conv=32, upscale=4):
        super().__init__(); s.upscale = upscale; s.body = nn.ModuleList()
        s.body.append(nn.Conv2d(3, num_feat, 3, 1, 1)); s.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            s.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1)); s.body.append(nn.PReLU(num_parameters=num_feat))
        s.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1)); s.upsampler = nn.PixelShuffle(upscale)
    def forward(s, x):
        out = x
        for m in s.body: out = m(out)
        return s.upsampler(out) + F.interpolate(x, scale_factor=s.upscale, mode='nearest')
class RDB(nn.Module):
    def __init__(s, nf=64, gc=32):
        super().__init__()
        s.conv1 = nn.Conv2d(nf, gc, 3, 1, 1); s.conv2 = nn.Conv2d(nf+gc, gc, 3, 1, 1)
        s.conv3 = nn.Conv2d(nf+2*gc, gc, 3, 1, 1); s.conv4 = nn.Conv2d(nf+3*gc, gc, 3, 1, 1)
        s.conv5 = nn.Conv2d(nf+4*gc, nf, 3, 1, 1); s.lrelu = nn.LeakyReLU(0.2, True)
    def forward(s, x):
        x1 = s.lrelu(s.conv1(x)); x2 = s.lrelu(s.conv2(torch.cat((x, x1), 1)))
        x3 = s.lrelu(s.conv3(torch.cat((x, x1, x2), 1))); x4 = s.lrelu(s.conv4(torch.cat((x, x1, x2, x3), 1)))
        return s.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x
class RRDB(nn.Module):
    def __init__(s, nf, gc=32):
        super().__init__(); s.rdb1 = RDB(nf, gc); s.rdb2 = RDB(nf, gc); s.rdb3 = RDB(nf, gc)
    def forward(s, x): return s.rdb3(s.rdb2(s.rdb1(x))) * 0.2 + x
class RRDBNet(nn.Module):
    def __init__(s, nf=64, nb=23, gc=32):
        super().__init__()
        s.conv_first = nn.Conv2d(3, nf, 3, 1, 1); s.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        s.conv_body = nn.Conv2d(nf, nf, 3, 1, 1); s.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1); s.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        s.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1); s.conv_last = nn.Conv2d(nf, 3, 3, 1, 1); s.lrelu = nn.LeakyReLU(0.2, True)
    def forward(s, x):
        feat = s.conv_first(x); feat = feat + s.conv_body(s.body(feat))
        feat = s.lrelu(s.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = s.lrelu(s.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        return s.conv_last(s.lrelu(s.conv_hr(feat)))
def sd(path):
    d = torch.load(path, map_location='cpu'); return d.get('params_ema', d.get('params', d))
import os, urllib.request
CACHE = os.path.join(os.path.dirname(__file__), '.cache')
WEIGHTS = {
    'wdn': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth',
    'general': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth',
    'x4plus': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
    'esrnet': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth',
}
def fetch(url):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, os.path.basename(url))
    if not os.path.exists(path): urllib.request.urlretrieve(url, path)
    return path
def load(name):
    m = SRVGGNetCompact() if name in ('general', 'wdn') else RRDBNet()
    m.load_state_dict(sd(fetch(WEIGHTS[name])))
    return m.eval()
