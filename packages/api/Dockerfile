# VAT Assist API. Build from the repository root:
#   docker build -f packages/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t vat-assist-api .
# Run migrations with the same image:
#   docker run --rm -e DATABASE_OWNER_URL=... vat-assist-api node packages/api/dist/scripts/migrate.js

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @vat-assist/api --workspace @vat-assist/shared --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run build -w @vat-assist/shared && npm run build -w @vat-assist/api

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --omit=dev --workspace @vat-assist/api --workspace @vat-assist/shared --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/migrations packages/api/migrations
COPY packages/api/seeds packages/api/seeds
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "packages/api/dist/main.js"]
