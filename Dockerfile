FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /app/data && chown node:node /app/data
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY LICENSE README.md ./
USER node
ENV DATA_DIR=/app/data
CMD ["node", "src/server.mjs"]
