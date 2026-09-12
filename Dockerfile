# Multi-stage: compile the TypeScript, then ship only the runtime bits.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# Configuration comes from the environment (docker compose injects .env);
# no secrets are baked into the image.
CMD ["node", "dist/index.js"]
