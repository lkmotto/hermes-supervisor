FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN mkdir -p /data
ENV HERMES_DB_PATH=/data/hermes.db

EXPOSE 8150

CMD ["node", "dist/index.js", "--http", "--host", "0.0.0.0", "--port", "8150"]
