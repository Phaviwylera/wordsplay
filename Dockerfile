FROM node:22-alpine AS build
RUN apk add --no-cache bash util-linux
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY lib ./lib
COPY public ./public
COPY test ./test
COPY deploy ./deploy
RUN npm test && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node api ./api
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --from=build --chown=node:node /app/public/wallet-bundle.js /app/public/derive-bundle.js ./public/
USER node
EXPOSE 3000
CMD ["node", "server.js"]
