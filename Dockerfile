# One image per service: `server` runs the API, dashboard and database,
# `runner` claims jobs and runs each in throwaway sibling containers.
# Node runs the TypeScript sources directly, and neither service needs
# npm packages at runtime; only the dashboard build does.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26-slim AS server
WORKDIR /app
ENV SHERPA_HOST=0.0.0.0 SHERPA_PORT=8080 SHERPA_DB=/data/sherpa.db SHERPA_DASHBOARD=/app/dist/dashboard
COPY package.json ./
COPY src ./src
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server/main.ts"]

FROM docker:29-cli AS docker-cli

FROM node:26-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
# Bare repos mounted at /repos belong to a host user, not the runner's root
RUN git config --system --add safe.directory '/repos/*'
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
ENV SHERPA_WORK=/work
COPY package.json ./
COPY src ./src
# The runner talks to the host's Docker daemon, which takes root; job containers get none of this
CMD ["node", "src/runner/main.ts"]
