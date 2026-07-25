FROM node:lts AS builder
WORKDIR /app
COPY package*.json ./
COPY packages packages
# The landing Arcade lazy-loads @msgboard/games + @msgboard/settle (workspaces under games/), so the
# games workspaces must be present for `npm i` to resolve the workspace symlinks and for vite to bundle
# the engine. These packages export TS source (main = src/index.ts), so no prebuild step is needed.
COPY games games
ARG VITE_RPC_1
ENV VITE_RPC_1=$VITE_RPC_1
ARG VITE_RPC_369
ENV VITE_RPC_369=$VITE_RPC_369
ARG VITE_RPC_943
ENV VITE_RPC_943=$VITE_RPC_943
# The landing house bot's signing address, pinned so the player verifies its OpenTerms signature and the
# public feed only trusts this house's transcripts. Unset → those pinned checks are skipped (fair either way).
ARG VITE_LANDING_HOUSE_ADDRESS
ENV VITE_LANDING_HOUSE_ADDRESS=$VITE_LANDING_HOUSE_ADDRESS
RUN npm i
RUN npm run build

FROM node:lts-slim
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
ENV NODE_ENV=production
ARG PORT=4173
ENV PORT=$PORT
EXPOSE $PORT
CMD ["npm", "run", "start"]
