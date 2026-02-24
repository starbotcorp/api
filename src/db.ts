// Database client (Prisma + SQLite)
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:../starbot.db';
}

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
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
