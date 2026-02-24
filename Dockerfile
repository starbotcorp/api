FROM node:22-slim

# Install OpenSSL 1.1 for Prisma
RUN apt-get update -y && apt-get install -y openssl libssl3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev deps for pino-pretty)
RUN npm ci

# Copy built code
COPY dist ./dist
COPY prisma ./prisma

# Generate Prisma client
RUN npx prisma generate

# Expose API port
EXPOSE 3737

# Run the API
CMD ["node", "dist/index.js"]
