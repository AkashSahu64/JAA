FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Keep dependency installation cacheable across application source changes.
# Prisma generation and workspace builds intentionally happen after the source
# tree is copied so they always reflect the current schema and code.
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json ./

RUN npx prisma generate --schema packages/database/prisma/schema.prisma
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOME=/home/jobagent
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system jobagent \
  && useradd --system --gid jobagent --create-home jobagent

# The application uses Playwright for supervised browser execution. Install the
# browser and its OS dependencies in the image rather than downloading them at
# runtime, where a worker could otherwise become nondeterministic.
RUN npx playwright install --with-deps chromium \
  && chown -R jobagent:jobagent /ms-playwright

COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts

# The runtime tree is immutable and only needs read access. Avoid recursively
# rewriting the dependency tree during every image build; the browser cache and
# home directory are explicitly owned by the runtime user above.
USER jobagent

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Override this command for the durable worker container.
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
