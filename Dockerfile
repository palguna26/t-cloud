FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/termyte-contract ./vendor/termyte-contract
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/termyte-contract ./vendor/termyte-contract
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
