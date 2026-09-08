FROM node:22.17.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY views ./views
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
COPY jest.config.cjs ./
CMD ["sh", "scripts/start.sh"]
