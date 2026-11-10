FROM python:3.13-slim-trixie

ARG APT_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium

# System Chromium instead of `playwright install`; no extra fonts are needed to read the pages.
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --root-user-action=ignore --index-url "${PIP_INDEX_URL}" -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

WORKDIR /app
COPY sgcc /app/sgcc
# `python -I` ignores PYTHONPATH and the working directory; a .pth file puts /app on sys.path.
RUN python -c "import pathlib, sysconfig; pathlib.Path(sysconfig.get_path('purelib'), 'fetcher.pth').write_text('/app\n')" \
    && useradd --system --uid 10001 --create-home --home-dir /home/fetcher fetcher

USER fetcher

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-I", "-c", "import os, urllib.request as u; u.build_opener(u.ProxyHandler({})).open(u.Request('http://127.0.0.1:8000/health', headers={'Authorization': 'Bearer ' + os.environ['FETCHER_TOKEN']}), timeout=4)"]

CMD ["python", "-I", "-m", "sgcc.server"]
