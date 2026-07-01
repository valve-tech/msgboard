FROM node:lts-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PONDER_TELEMETRY_DISABLED=true
EXPOSE 42069
# sh -c so PONDER_SCHEMA expands at runtime (mirrors deploy/games-indexer). Each (re)index runs into a
# fresh Postgres schema safe_<n> so a rebuild never clashes with live data. PONDER_RPC_URL_369 and
# PONDER_RPC_URL_943 must point at msgboard-enabled RPCs (e.g. https://one.valve.city/rpc/vk_demo/evm/369).
CMD ["sh", "-c", "npx ponder start --hostname 0.0.0.0 --port 42069 --schema \"${PONDER_SCHEMA:?PONDER_SCHEMA must be set (e.g. safe_0)}\""]
