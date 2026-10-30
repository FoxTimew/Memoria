FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS isolation
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY isolate.c /src/isolate.c
RUN gcc -O2 -Wall -Wextra -Werror /src/isolate.c -o /isolate

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /validator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY validate.mjs fixture.mjs service.mjs ./
COPY --from=isolation /isolate /validator/isolate
USER node
ENV MALLOC_ARENA_MAX=2 UV_THREADPOOL_SIZE=1
ENTRYPOINT ["/validator/isolate", "--supervisor", "node", "--max-old-space-size=96", "/validator/service.mjs"]
