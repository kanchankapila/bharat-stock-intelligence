FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY config ./config
COPY migrations ./migrations
# editable: migrations/ and config/ are read relative to the source tree
RUN pip install --no-cache-dir -e .
ENV BQA_ARTIFACTS_DIR=/data/artifacts
VOLUME ["/data"]
CMD ["bqa", "scheduler"]
