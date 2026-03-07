FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY . .
RUN npm run build

RUN mkdir -p /data

ENV DATABASE_PATH=/data/vibeworld.db
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
