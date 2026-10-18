FROM ghcr.io/astral-sh/uv:0.12.9 AS uv
FROM python:3.12-slim
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    DOCUMENT_PARSER_MODELS=/models DOCUMENT_PARSER_CACHE=/cache OMP_NUM_THREADS=2
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY adapter.py app.py worker.py bootstrap.py probe.py ./
RUN useradd --uid 10001 --create-home parser && mkdir /models /cache && chown parser:parser /models /cache
USER parser
EXPOSE 7821
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7821", "--workers", "1"]
