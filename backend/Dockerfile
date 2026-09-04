# ---- build ----
# Base tags float on purpose for minor-patch currency; before production
# deployment pin both stages by digest:
#   docker pull node:22-alpine   # then `docker manifest inspect` for the digest
#   FROM node:22-alpine@sha256:<digest>
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: no dependency here needs install scripts, and none ever
# should — a postinstall is the classic supply-chain execution vector.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && addgroup -S app && adduser -S app -G app
COPY --from=build /app/dist ./dist
USER app
EXPOSE 8080
VOLUME ["/app/data"]
# --start-period: slow first boots (cold registry load) must not be killed
# as unhealthy before the server is even listening.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1
CMD ["node", "dist/index.js"]
