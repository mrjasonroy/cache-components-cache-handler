FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cache-handler/package.json packages/cache-handler/package.json
COPY apps/e2e-test-app/package.json apps/e2e-test-app/package.json
RUN pnpm install --frozen-lockfile
COPY --from=handler packages/cache-handler packages/cache-handler
COPY apps/e2e-test-app apps/e2e-test-app
# Negative control lives only in this throwaway image; never changes the checkout.
ARG REVERT_TIMESTAMP=0
RUN if [ "$REVERT_TIMESTAMP" = 1 ]; then \
      sed -i 's/lastModified: this.renderStarts.get(cacheKey) ?? nowMs()/lastModified: nowMs()/' packages/cache-handler/src/handlers/redis.ts; \
    fi
RUN pnpm --filter @mrjasonroy/cache-components-cache-handler build
ARG USE_CACHE=memory
ENV E2E_USE_CACHE=$USE_CACHE
ENV E2E_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1 REDIS_URL=redis://redis:6379
RUN pnpm --filter e2e-test-app build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/apps/e2e-test-app/.next/standalone ./
COPY --from=build /app/apps/e2e-test-app/.next/static ./apps/e2e-test-app/.next/static
COPY k8s/e2e/driver.mjs ./apps/e2e-test-app/driver.mjs
USER node
CMD ["node", "apps/e2e-test-app/server.js"]
