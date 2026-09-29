#!/bin/bash
# macOS: 더블클릭으로 실행 / Linux: 터미널에서 ./start.command
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3가 필요합니다. https://www.python.org/downloads/ 에서 설치해 주세요."
  command -v open >/dev/null && open "https://www.python.org/downloads/"
  read -r -p "엔터를 누르면 닫힙니다."
  exit 1
fi

if [ ! -f .venv/installed.txt ]; then
  echo "처음 실행 준비 중입니다. 몇 분 정도 걸릴 수 있습니다..."
  python3 -m venv .venv &&
    .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt &&
    echo ok > .venv/installed.txt || {
      echo "설치 중 문제가 발생했습니다. 인터넷 연결을 확인한 뒤 .venv 폴더를 지우고 다시 실행해 주세요."
      read -r -p "엔터를 누르면 닫힙니다."
      exit 1
    }
fi

exec .venv/bin/python app.py
