FROM node:20-alpine as build

WORKDIR /app

COPY package.json package-lock.json nx.json ./
RUN npm ci

COPY tsconfig.base.json nx.json ./
COPY apps/website ./apps/website
COPY libs ./libs

ARG AUTH_ORIGIN

RUN npx nx build website --generate


FROM node:20-alpine as serve

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/dist/apps/website /app
WORKDIR /app/server
RUN npm i

CMD ["node", "index.mjs"]
