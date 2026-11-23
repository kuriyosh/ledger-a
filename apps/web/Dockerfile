FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
    && pnpm --filter @ledgera/web install --frozen-lockfile
COPY apps/web/ apps/web/
RUN pnpm --filter @ledgera/web build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]
