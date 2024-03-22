FROM node:20-alpine as build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json nx.json ./
COPY apps/website ./apps/website
COPY libs ./libs

RUN npx nx build website --generate


FROM nginx:mainline-alpine as serve

COPY deploy/nginx.conf /etc/nginx/conf.d
RUN mkdir /etc/nginx/conf.d/proxy
COPY deploy/nginx-proxy.conf /etc/nginx/conf.d/proxy
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist/apps/website/public /app
