FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY admin ./admin
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# strip Windows line endings in case the repo was edited on Windows
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data && chown -R node:node /app/data
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# the entrypoint fixes /app/data ownership, then runs the app as the "node" user
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
