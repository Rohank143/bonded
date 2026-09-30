# Bonded Sentinel: Laya on CPU (Railway has no GPUs). See docs/SENTINEL.md.
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 HF_HOME=/app/.cache/huggingface
# CPU-only PyTorch keeps the image small; Laya falls back to CPU anyway without a GPU.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
EXPOSE 8000
CMD ["python", "server.py"]
