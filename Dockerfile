FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib

ENV NODE_ENV=production

EXPOSE 8787

CMD ["node", "server.js"]
