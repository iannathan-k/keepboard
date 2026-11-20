FROM python:3.12-alpine

# Environment configuration
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

# Add curl for container health checks
RUN apk add --no-cache curl

# Create non-root user and group (UID 1000, GID 1000)
RUN addgroup -g 1000 keepboard && \
    adduser -u 1000 -G keepboard -s /bin/sh -D keepboard && \
    mkdir -p /app /data/files && \
    chown -R keepboard:keepboard /app /data

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY --chown=keepboard:keepboard app/ /app/

# Switch to UID/GID 1000:1000
USER 1000:1000

# Internal container port
EXPOSE 8080

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Run Uvicorn server on port 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
