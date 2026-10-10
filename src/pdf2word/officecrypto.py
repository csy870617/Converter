# 암호 걸린 Office 문서(docx·xlsx·pptx와 옛 doc·xls·ppt)의 암호를 푼다 (msoffcrypto-tool).
# 문서 변환 엔진(LibreOffice)은 브라우저에서 Office 문서의 암호를 풀지 못해 여기서 먼저 푼다.
import msoffcrypto
from msoffcrypto.exceptions import DecryptionError, InvalidKeyError


def decrypt(src, dst, password=None):
    """암호를 풀어 dst에 쓴다. 암호가 걸려 있지 않으면 False."""
    with open(src, 'rb') as f:
        office = msoffcrypto.OfficeFile(f)
        if not office.is_encrypted():
            return False
        try:
            office.load_key(password=password or '', verify_password=True)
            with open(dst, 'wb') as out:
                office.decrypt(out)
        except (InvalidKeyError, DecryptionError) as e:
            raise RuntimeError('PASSWORD_REQUIRED') from e
    return True
