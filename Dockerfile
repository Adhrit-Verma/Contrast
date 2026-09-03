# Pinned to the exact puppeteer version in package-lock.json (check with
# `node -e "console.log(require('./package-lock.json').packages['node_modules/puppeteer'].version)"`
# — NOT the caret range in package.json, which can drift ahead of it). This
# image ships exactly that Chrome build plus every shared lib it needs, so we
# never hand-maintain an apt-get list that breaks on the next base-image update.
FROM ghcr.io/puppeteer/puppeteer:25.10.0

# The image's default user (pptruser) can't write to /app until we chown it.
USER root
WORKDIR /app
# Must be set BEFORE `npm ci` — puppeteer's postinstall reads it at install
# time, not at runtime. Set after, it silently no-ops and puppeteer tries (and
# in a build environment, may fail) to fetch its own Chrome instead of reusing
# the one already baked into this image.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p sessions runs && chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 4321
# Loopback-only bind is enforced in src/ui/server.js itself, not here — see
# docker-compose.yml for how that's reached from outside the container.
CMD ["node", "src/cli.js", "ui", "4321"]
