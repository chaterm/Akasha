FROM node:22-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g pnpm@10.4.0 \
    && pnpm config set store-dir /pnpm/store

FROM base AS builder

WORKDIR /app

COPY . .

RUN --mount=type=cache,id=akasha-pnpm-linux-amd64,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

RUN pnpm build


FROM base AS installer

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl bash tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo "$TZ" > /etc/timezone

WORKDIR /app

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/
COPY --from=builder /app/.npmrc /app/.npmrc

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN --mount=type=cache,id=akasha-pnpm-linux-amd64,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod

RUN mkdir -p /app/data/storage \
    && chown -R node:node /app

USER node

VOLUME ["/app/data/storage"]

EXPOSE 3000

CMD ["pnpm", "start"]