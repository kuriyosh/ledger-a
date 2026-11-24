ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
ARG PNPM_VERSION

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/rpc-proxy/package.json services/rpc-proxy/package.json
RUN npm install -g "pnpm@$PNPM_VERSION" \
    && pnpm --filter @ledgera/rpc-proxy install --prod --frozen-lockfile

COPY services/rpc-proxy/src/ services/rpc-proxy/src/
WORKDIR /app/services/rpc-proxy
ENV HOST=0.0.0.0
USER node
CMD ["node", "src/index.ts"]
