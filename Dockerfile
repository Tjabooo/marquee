# syntax=docker/dockerfile:1
# Marquee: one Node.js process, no npm dependencies. ffmpeg and Tesseract come from Debian.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js setup.js whats-new.json ./
COPY src ./src
COPY public ./public
COPY agents ./agents

# State lives in /data (mount a volume), media in /media. Settings come from the environment or
# from /data/.env. HOST=0.0.0.0 is required inside a container; publish the port to choose exposure.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    MARQUEE_ENV_FILE=/data/.env \
    HOST=0.0.0.0 \
    PORT=8080

RUN mkdir -p /data /media && chown node:node /data /media
USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini reaps ffmpeg helpers and forwards SIGTERM; Marquee shuts down cleanly on it.
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]

LABEL org.opencontainers.image.source="https://github.com/Tjabooo/marquee" \
      org.opencontainers.image.description="Self-hosted, phone-first media server" \
      org.opencontainers.image.title="Marquee"
