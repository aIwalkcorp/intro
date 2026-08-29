# PersonaForge API — build context 是 personaforge/（不是 api/）
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn anthropic python-multipart cryptography

COPY api/server.py /app/
COPY index.html /app/
COPY art/ /app/art/
COPY demo/ /app/demo/

ENV PF_DATA=/data
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
