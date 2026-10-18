FROM node:24-alpine

ENV NODE_ENV=production \
    PHREMOTE_HOST=0.0.0.0 \
    PHREMOTE_PORT=8787 \
    PHREMOTE_STORE=/var/lib/phremote/devices.json

WORKDIR /app
COPY --chown=node:node server/*.mjs ./server/
RUN mkdir -p /var/lib/phremote && chown node:node /var/lib/phremote

USER node:node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
