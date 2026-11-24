ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
ARG PNPM_VERSION
ARG SERVICE

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/abis/package.json packages/abis/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/${SERVICE}/package.json services/${SERVICE}/package.json
RUN npm install -g "pnpm@$PNPM_VERSION" \
    && pnpm --filter "@ledgera/${SERVICE}..." install --prod --frozen-lockfile

COPY packages/abis/src/ packages/abis/src/
COPY packages/config/src/ packages/config/src/
COPY packages/shared/src/ packages/shared/src/
COPY services/${SERVICE}/src/ services/${SERVICE}/src/
WORKDIR /app/services/${SERVICE}
ENV HOST=0.0.0.0
USER node
CMD ["node", "src/index.ts"]
