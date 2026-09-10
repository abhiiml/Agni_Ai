# Dockerfile for AGNI-AI Production Container Deployment
FROM python:3.10-slim

# Prevent Python from writing .pyc files & enable unbuffered stdout
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000 \
    HOST=0.0.0.0

WORKDIR /app

# Install system dependencies if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy python dependencies file and install
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application codebase
COPY . .

# Expose application port
EXPOSE 8000

# Healthcheck for container orchestration (Docker / K8s)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8000/healthz || exit 1

# Launch FastAPI Uvicorn ASGI Server
CMD ["python", "main.py"]
