FROM node:lts AS builder
WORKDIR /app
COPY package*.json ./
COPY packages packages
ARG VITE_RPC_1
ENV VITE_RPC_1=$VITE_RPC_1
ARG VITE_RPC_369
ENV VITE_RPC_369=$VITE_RPC_369
ARG VITE_RPC_943
ENV VITE_RPC_943=$VITE_RPC_943
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
