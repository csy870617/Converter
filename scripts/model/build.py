# AI 화질 개선 모델을 만든다 (모두 반정밀도판 -fp16.onnx 함께)
#   public/models/fidelity-x4.onnx       사진용: Real-ESRGAN realesr-general-wdn-x4v3 + 충실도 보정
#   public/models/fidelity-anime-x4.onnx 그림용: Real-ESRGAN RealESRGAN_x4plus_anime_6B + 충실도 보정
#   python3 -m venv .venv && .venv/bin/pip install torch onnx onnxruntime onnxconverter-common
#   .venv/bin/python scripts/model/build.py [wdn|anime6b]   (비우면 둘 다)
import os, sys, numpy as np, torch, onnx, onnxruntime as ort
from onnxconverter_common import float16
from arch import load
from fidelity import Fidelity

root = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'models')
OUT = {'wdn': 'fidelity-x4', 'anime6b': 'fidelity-anime-x4'}
for name in sys.argv[1:] or OUT:
    fp32, fp16 = os.path.join(root, f'{OUT[name]}.onnx'), os.path.join(root, f'{OUT[name]}-fp16.onnx')
    m = Fidelity(load(name)).eval()
    x, core, soft, sharp, radius = torch.rand(1, 3, 40, 56), torch.tensor([0.015]), torch.tensor([1.0]), torch.tensor([1.0]), torch.tensor([2.0])
    torch.onnx.export(m, (x, core, soft, sharp, radius), fp32, input_names=['input', 'core', 'soft', 'sharp', 'radius'], output_names=['output'], opset_version=17,
                      dynamic_axes={'input': {2: 'h', 3: 'w'}, 'output': {2: 'H', 3: 'W'}}, dynamo=False)
    onnx.save(float16.convert_float_to_float16(onnx.load(fp32), keep_io_types=True), fp16)

    feeds = {'input': x.numpy(), 'core': core.numpy(), 'soft': soft.numpy(), 'sharp': sharp.numpy(), 'radius': radius.numpy()}
    with torch.no_grad(): ref = m(x, core, soft, sharp, radius).numpy()
    for path in (fp32, fp16):
        y = ort.InferenceSession(path).run(None, feeds)[0]
        print(f'{os.path.basename(path)}: {os.path.getsize(path) / 1e6:.1f}MB, PyTorch와 평균 차이 {np.abs(y - ref).mean():.6f}')
