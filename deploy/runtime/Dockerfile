FROM oven/bun:1.3.13 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
# postinstall can migrate a brain. It must never run during image construction.
RUN bun install --frozen-lockfile --ignore-scripts --no-progress

FROM oven/bun:1.3.13
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git util-linux tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json VERSION ./
COPY src ./src
COPY admin/dist ./admin/dist
COPY skills ./skills
COPY deploy/runtime ./deploy/runtime
# Match ownership of existing product persistence, not an agent account's tools.
USER 1001:1001
EXPOSE 3131 3132 3133
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/deploy/runtime/entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3132/health"); process.exit(r.ok ? 0 : 1)'
