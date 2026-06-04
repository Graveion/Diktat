# Diktat relay — single Bun process (Bun.serve WebSockets).
FROM oven/bun:1-alpine

WORKDIR /app

# Install deps against the committed lockfile (only `jose` at runtime).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source. .dockerignore keeps test/smoke scripts and secrets out.
COPY . .

# Fly routes to this port; index.ts reads process.env.PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "index.ts"]
