# AdPilot — runs on Node 22 (native TypeScript stripping + node:sqlite, zero deps)
FROM node:22-slim AS runtime

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    ADPILOT_DRY_RUN=1

# Render (and most PaaS) inject PORT at runtime; the server binds 0.0.0.0:$PORT.
EXPOSE 8787

# The server migrates + seeds-on-boot if the DB is empty, then serves the dashboard + API.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/api/server.ts"]
