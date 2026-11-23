FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/rpc-proxy/package.json services/rpc-proxy/package.json
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
    && pnpm --filter @ledgera/rpc-proxy install --prod --frozen-lockfile

COPY services/rpc-proxy/src/ services/rpc-proxy/src/
WORKDIR /app/services/rpc-proxy
ENV HOST=0.0.0.0
USER node
CMD ["node", "src/index.ts"]
