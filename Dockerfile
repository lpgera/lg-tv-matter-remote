FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Holds the TV client key and the Matter fabric data, mount a volume here
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node
CMD ["node", "src/index.ts"]
