FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MOONSHINE_VOICE_CACHE=/models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the models into the image so containers start without a download.
ARG MODELS="medium small"
RUN python -c "import sys; from moonshine_voice import ModelArch, get_model_for_language; \
[get_model_for_language('en', getattr(ModelArch, m.upper() + '_STREAMING')) for m in sys.argv[1:]]" $MODELS

COPY server.py .
COPY static static
COPY data data

RUN useradd --system --no-create-home app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

# TLS is terminated by nginx in front of the container.
ENTRYPOINT ["python", "server.py", "--host", "0.0.0.0", "--port", "8000", "--no-tls"]
CMD ["--model", "medium", "--max-sessions", "4"]
