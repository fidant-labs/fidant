# Build from the repository root: docker build -f apps/server/Dockerfile .
# Node's major is .node-version's, which src/image.test.ts checks.
# The server makes its self-signed certificate with openssl.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
  && pnpm install --frozen-lockfile --prod --ignore-scripts --filter @fidant/server...
COPY apps/server/src apps/server/src
COPY apps/server/relays.json apps/server/entrypoint.sh apps/server/
COPY packages/protocol/src packages/protocol/src

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN apk add --no-cache openssl && install -d -o node -g node -m 700 /run/fidant
COPY --from=build /app /app
WORKDIR /app
USER node
ENTRYPOINT ["/bin/sh", "/app/apps/server/entrypoint.sh"]
CMD ["node", "apps/server/src/main.ts"]
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
