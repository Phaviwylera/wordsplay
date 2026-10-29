FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN mkdir public && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node api ./api
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --from=build --chown=node:node /app/public/wallet-bundle.js ./public/wallet-bundle.js
USER node
EXPOSE 3000
CMD ["node", "server.js"]
