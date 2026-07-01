# Build context is the repo root (not render-service/) -- this service imports the real
# ../src/render files directly (see build.js/entry.js) and needs ../src/assets/images's star
# sprites plus ../public/createjs.min.js at runtime (see render.js/shim.js), all of which live
# outside render-service/. Deploy from repo root:
#   flyctl deploy . --config render-service/fly.toml --dockerfile render-service/Dockerfile
#
# node:20-slim is glibc (Debian), matching the prebuilt @napi-rs/canvas-linux-x64-gnu binary
# -- no Chromium system deps needed, @napi-rs/canvas ships its native addon prebuilt.

FROM node:20-slim AS build
WORKDIR /app
COPY render-service/package.json render-service/package-lock.json ./render-service/
RUN cd render-service && npm ci
COPY src/render ./src/render
COPY src/components/Canvas ./src/components/Canvas
COPY render-service/entry.js render-service/build.js ./render-service/
RUN cd render-service && node build.js

FROM node:20-slim AS runtime
WORKDIR /app
COPY render-service/package.json render-service/package-lock.json ./render-service/
RUN cd render-service && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/render-service/generated ./render-service/generated
COPY render-service/server.js render-service/render.js render-service/shim.js ./render-service/
COPY src/assets/images/star-sprite-large.png src/assets/images/star-sprite-small.png ./src/assets/images/
COPY public/createjs.min.js ./public/createjs.min.js

ENV PORT=8080
EXPOSE 8080
WORKDIR /app/render-service
CMD ["node", "server.js"]
