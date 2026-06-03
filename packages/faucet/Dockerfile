FROM node:lts-alpine as frontend

WORKDIR /frontend-build

COPY ./web/package*.json ./
RUN npm install

COPY ./web .
RUN npm run build

FROM golang:1.16-alpine as backend

RUN apk add --no-cache gcc musl-dev linux-headers

WORKDIR /backend-build

COPY . .
COPY --from=frontend /frontend-build/public ./web/public

RUN go build -o pls-faucet -ldflags "-w -s"

FROM alpine

RUN apk add --no-cache ca-certificates
WORKDIR /app

COPY --from=backend /backend-build/pls-faucet .

EXPOSE 8080

# Honor the platform-injected $PORT (Railway/Heroku) and set the flags the
# Procfile used to pass -- the Dockerfile path ignores the Procfile, so they
# must live here. proxycount=1 makes the rate limiter read X-Forwarded-For
# instead of the upstream proxy IP; falls back to sane defaults when unset.
ENTRYPOINT ["/bin/sh", "-c", "./pls-faucet -httpport ${PORT:-8080} -proxycount ${PROXY_COUNT:-1} -payout ${PAYOUT:-10}"]
