FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*
# runs as root, so the bot can apt-get install what it needs. root only inside this container: see cap_add in docker-compose.yml
RUN mkdir /workspace
ENV HOME=/workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
