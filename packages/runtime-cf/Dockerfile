# packages/runtime-cf/Dockerfile
FROM --platform=linux/amd64 node:22-bookworm-slim AS build

RUN npm install --global pnpm@10.15.0
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/runtime-container/package.json packages/runtime-container/package.json
COPY strategies/flip-flat/package.json strategies/flip-flat/package.json
RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY packages/runtime-container packages/runtime-container
COPY strategies/flip-flat strategies/flip-flat
RUN pnpm --filter @quotient/cassie-runtime-container... build
RUN pnpm --filter @quotient/cassie-runtime-container deploy --prod --legacy /release

FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
