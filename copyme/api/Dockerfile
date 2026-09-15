# PersonaForge API — build context 是 personaforge/（不是 api/）
FROM python:3.12-slim

WORKDIR /app
# httpx 要顯式列出：server.py 直接 import（登入驗證 / auth proxy），
# 過去靠 anthropic 間接帶進來，新版不再保證，隱性相依斷過一次。
RUN pip install --no-cache-dir fastapi uvicorn anthropic python-multipart cryptography httpx

COPY api/server.py /app/
COPY index.html /app/
COPY art/ /app/art/
COPY demo/ /app/demo/

ENV PF_DATA=/data
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
