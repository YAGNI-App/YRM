# YRM in a container: the compiled `yrm` binary on Debian slim (ADR 0011).
#
#   docker build -t yrm .
#   docker run --rm -p 7777:7777 -v yrm-data:/data yrm
#
# /data is the project directory: yrm.config.ts, the SQLite store under
# .yrm/local/, and .yrm/extensions/*.ts. With no config there, the entrypoint
# runs `yrm init` once. Any other command runs as `docker run ... yrm <args>`,
# e.g. `docker run --rm -v yrm-data:/data -v ~/mail:/import:ro yrm import /import`.

# The builder runs on the build machine's arch and cross-compiles for the
# target, so multi-arch images need no emulation to build the binary.
ARG BUN_VERSION=1
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY scripts ./scripts
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun run scripts/build.ts --target "$target" --outfile /out/yrm

# glibc (the Bun runtime needs it), CA certificates for model providers and
# Gmail, and a shell for the entrypoint. distroless/cc would also run the
# binary but has no shell for the first-run init.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 yrm \
 && useradd --system --uid 10001 --gid yrm --home-dir /data --shell /usr/sbin/nologin yrm \
 && mkdir -p /data \
 && chown yrm:yrm /data
COPY --from=build /out/yrm /usr/local/bin/yrm
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER yrm
WORKDIR /data
VOLUME /data
ENV TZ=UTC

# 7777: the web dashboard (`yrm web`). 7788: MCP over HTTP (`yrm serve --http`),
# which is not in 0.1 yet; stdio MCP works today with `docker run -i ... serve`.
EXPOSE 7777 7788

ENTRYPOINT ["docker-entrypoint.sh"]
# Binding beyond loopback has no authentication in 0.1: anyone who can reach
# the port can read and change your data. Publish it to localhost only
# (-p 127.0.0.1:7777:7777) or put it behind your own auth. Once auth (#33)
# lands, a non-loopback bind will require a token, and once MCP over HTTP
# ships the default becomes `serve --http 7788 --host 0.0.0.0`.
CMD ["web", "--host", "0.0.0.0", "--port", "7777"]
