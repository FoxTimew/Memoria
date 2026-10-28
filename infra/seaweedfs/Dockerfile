# Runtime remains the pinned upstream 4.51 image. Only the Go weed binary changes.
# Build the binary with scripts/build-storage-fixture.mjs, never with an unpinned toolchain.
FROM chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8
ARG MEMORIA_PATCH_SHA256
LABEL org.opencontainers.image.source="https://github.com/seaweedfs/seaweedfs" \
      memoria.upstream.commit="153ab668c99731a6d29492bf6c61d0b4fa701101" \
      memoria.multipart.patch.sha256=$MEMORIA_PATCH_SHA256
COPY --chmod=755 weed /usr/bin/weed
