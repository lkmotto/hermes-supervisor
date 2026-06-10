FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

RUN mkdir -p /data
ENV HERMES_DB_PATH=/data/hermes.db

EXPOSE 8150

CMD ["node", "dist/index.js", "--http", "--host", "0.0.0.0", "--port", "8150"]
