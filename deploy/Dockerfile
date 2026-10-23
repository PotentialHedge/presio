# Build image for the Presio app (referenced by deploy/docker-compose.yml).
# Build context is the repo root so both client/ and server/ are available.
#
# Stage 1 builds the React client. Vite inlines VITE_* values at build time, so
# they must be present as env (not just runtime). The publishable/anon key is a
# public key and is safe to bake into the client bundle.
#
# Pinned to the build host's own architecture: the output is just JS/CSS, so
# there is nothing arch-specific to emulate. Without this, the arm64 leg of the
# multi-arch release build runs Vite under QEMU for no benefit.
# Digest-pinned so a rebuild of an old release reproduces it; Dependabot
# (.github/dependabot.yml) proposes the bumps.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ .
# Code the client and server share (imported as @shared and ../shared).
COPY shared/ /app/shared
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG VITE_SENTRY_DSN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
RUN npm run build

# Stage 2 runs the server, which serves the API, the websocket, and the built
# client from ../client/dist (see server/index.ts).
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
WORKDIR /app/server
COPY server/package*.json ./
# better-sqlite3 (local mode's storage backend) is a native module with no
# musl prebuilds, so it compiles from source here and needs a toolchain;
# removed again once npm ci finishes since the compiled .node binary only
# needs libstdc++/libgcc at runtime, which the base image already carries.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps
COPY server/ .
COPY shared/ /app/shared
# The JSON schemas served at /schema/ (server/app.ts).
COPY schema/ /app/schema
COPY --from=client-build /app/client/dist /app/client/dist

# Baked in so a running container can say which build it is (served on
# /healthz). Defaults to "dev" for images built outside the release workflow.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 3001

# Lets `restart:` policies and orchestrators react to a wedged process rather
# than only to one that has exited. Uses busybox wget (already in the base
# image) against the cheap liveness probe in server/app.ts; start-period covers
# first boot, where local mode creates and migrates the SQLite database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT:-3001}/healthz || exit 1

CMD ["npm", "start"]
