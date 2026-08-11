FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
COPY test ./test
COPY web ./web

RUN pnpm typecheck && pnpm test && pnpm build:server
RUN pnpm prune --prod


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/web/dist ./web/dist

USER node

EXPOSE 3000

CMD ["node", "--enable-source-maps", "dist/src/index.js"]


# Export a self-contained application directory plus the Linux Node binary for
# hosts that run systemd but do not install Node globally.
FROM scratch AS bundle

COPY --from=runtime /usr/local/bin/node /runtime/node
COPY --from=runtime /app /app
