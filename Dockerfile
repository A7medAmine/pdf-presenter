# PDF Presenter — container image
# Multi-stage build: dependencies are installed in a throwaway stage.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

# LibreOffice converts PowerPoint uploads to PDF. Build with
# `--build-arg OFFICE=false` for a much smaller, PDF-only image.
ARG OFFICE=true
RUN if [ "$OFFICE" = "true" ]; then \
      apk add --no-cache libreoffice-impress font-noto font-noto-arabic ttf-liberation \
      && rm -rf /var/cache/apk/*; \
    fi

# Writable runtime directories owned by the unprivileged `node` user.
RUN mkdir -p /app/uploads /app/data && chown node:node /app/uploads /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
