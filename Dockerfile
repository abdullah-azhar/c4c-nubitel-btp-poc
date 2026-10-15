# Container image for the BTP lean view, to run on SAP BTP Kyma.
# Build from the repo root (the view imports ../lib):
#   docker build -t c4c-lean-view:0.1.0 .
# There are no npm dependencies, so there is no install step.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY btp-view ./btp-view

# The official image ships a non-root "node" user (uid 1000).
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "btp-view/server.js"]
