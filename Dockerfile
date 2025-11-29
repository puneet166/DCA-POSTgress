# Dockerfile - Node 20 Alpine (no TS build step; JS runtime)
FROM node:20-alpine

# Basic utils
RUN apk add --no-cache bash ca-certificates

WORKDIR /app

# install dependencies
COPY package*.json ./
RUN npm ci --no-optional

# copy source
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# default entry -- starts API. Worker service will override to run worker.
CMD ["node", "src/index.js"]
