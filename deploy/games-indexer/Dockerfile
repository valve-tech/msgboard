FROM node:lts-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PONDER_TELEMETRY_DISABLED=true
EXPOSE 42069
# sh -c so PONDER_SCHEMA expands at runtime (mirrors deploy/random-indexer's run command). Each
# (re)index runs into a fresh Postgres schema games_943_<n> so a rebuild never clashes with live data.
CMD ["sh", "-c", "npx ponder start --hostname 0.0.0.0 --port 42069 --schema \"${PONDER_SCHEMA:?PONDER_SCHEMA must be set (e.g. games_943_0)}\""]
