FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /validator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY validate.mjs fixture.mjs ./
USER node
ENV MALLOC_ARENA_MAX=2 UV_THREADPOOL_SIZE=1
ENTRYPOINT ["node", "--max-old-space-size=96", "/validator/validate.mjs"]
