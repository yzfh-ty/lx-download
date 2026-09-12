FROM alpine AS base

FROM base AS builder
WORKDIR /source-code
COPY . .

RUN apk add --update \
  g++ \
  make \
  py3-pip \
  nodejs \
  npm \
  && npm install --ignore-scripts --no-audit --no-fund \
  && npx tsc --project tsconfig.json \
  && npx tsc-alias -p tsconfig.json \
  && rm -rf node_modules && npm install --omit=dev --no-audit --no-fund \
  && mkdir -p build-output \
  && mv server node_modules index.js package.json public -t build-output


FROM base AS final
WORKDIR /server

RUN apk add --update --no-cache nodejs

COPY --from=builder ./source-code/build-output ./

VOLUME /server/data /server/cache /server/download /server/logs
ENV DATA_PATH='/server/data'
ENV LOG_PATH='/server/logs'

EXPOSE 9527
ENV NODE_ENV='production'
ENV PORT=9527
ENV BIND_IP='0.0.0.0'
# ENV PROXY_HEADER 'x-real-ip'
# ENV CONFIG_PATH '/server/config.js'
# ENV WEBPLAYER_TOKEN 'change-me'  # Web 访问 Token
# ENV LOG_PATH '/server/logs'
# ENV DATA_PATH '/server/data'

CMD [ "node", "index.js" ]
