// Database client (Prisma + SQLite)
import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// For SQLite, we need to ensure proper connection handling
// The connectionLimit option is not officially documented for Prisma
// Instead, we use connection_timeout and proper error handling
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  // For SQLite: use connection_timeout to prevent hanging requests
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
