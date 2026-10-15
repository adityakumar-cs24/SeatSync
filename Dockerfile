FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS deps-all
RUN npm ci

FROM base AS deps-prod
RUN npm ci --omit=dev

FROM deps-all AS migrate
COPY migrations ./migrations
USER node
CMD ["npx", "node-pg-migrate", "up"]

FROM deps-prod AS runtime
ENV NODE_ENV=production
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 5000
CMD ["node", "src/server.js"]
