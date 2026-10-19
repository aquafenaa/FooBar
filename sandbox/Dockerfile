FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 agent && mkdir /workspace && chown 1000:1000 /workspace
USER agent
ENV HOME=/workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
