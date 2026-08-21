# Shared base for ml-api, chatbot, and alphaquant-api: all three run under the SAME
# production interpreter (backend-python/venv, per ecosystem.config.cjs's VENV_PY) against
# the SAME backend-python/requirements.txt -- confirmed live 2026-08-20, not the root
# requirements.txt CLAUDE.md's service table might suggest. Building one base image (rather
# than repeating this install three times) avoids re-downloading torch/transformers/
# chromadb -- multiple GB -- for every service.
#   docker build -f docker/python-base.Dockerfile -t bharat-python-base .
FROM python:3.11-slim

WORKDIR /app

# ORDER MATTERS -- mirrors .github/workflows/ci.yml exactly. Installing the requirements
# file first (which pulls torch in via transformers/sentence-transformers) resolves the
# default CUDA wheel; CPU torch must be installed FIRST so it's already satisfied when
# transformers/sentence-transformers ask for torch, or you silently get a multi-GB CUDA
# wheel on a machine with no GPU. Do not reorder these two steps.
COPY backend-python/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && grep -v '^torch' /tmp/requirements.txt > /tmp/requirements-docker.txt \
    && pip install --no-cache-dir -r /tmp/requirements-docker.txt
