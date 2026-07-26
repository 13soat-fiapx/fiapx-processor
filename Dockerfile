FROM oven/bun:1.3.14

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src

CMD ["bun", "run", "worker"]
