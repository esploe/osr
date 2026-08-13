# syntax=docker/dockerfile:1

# Deliberately its own, much lighter image than docker/Dockerfile -- this
# process only talks to Discord's gateway and the coordinator's HTTP API,
# it never runs danser/ffmpeg/X11 itself, so none of that belongs here.
FROM node:20-bookworm-slim

WORKDIR /app
COPY bot/package.json ./
RUN npm install --omit=dev
COPY bot/src ./src

ENV BOT_DATA_DIR=/data
VOLUME /data

CMD ["node", "src/index.js"]
