// Starbot API - The Brain
// Port: 3737 (localhost only)

// Load environment variables from .env file
import 'dotenv/config';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { env, logConfiguration } from './env.js';
import { projectRoutes } from './routes/projects.js';
import { chatRoutes } from './routes/chats.js';
import { messageRoutes } from './routes/messages.js';
import { generationRoutes } from './routes/generation.js';
import { modelRoutes } from './routes/models.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { memoryRoutes } from './routes/memory.js';
import { authRoutes } from './routes/auth.js';
import { inferenceRoutes } from './routes/inference.js';
import { tasksRoutes } from './routes/tasks.js';
import { folderRoutes } from './routes/folders.js';
import { calendarRoutes } from './routes/calendar.js';
import { userRoutes } from './routes/users.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { initializeTools } from './services/tools/index.js';
import { extractAuthToken } from './security/route-guards.js';

const PORT = env.PORT;
const HOST = env.HOST;

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
});

// CORS for local development and production
await server.register(cors, {
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:3000',      // WebGUI (dev)
    'http://127.0.0.1:3000',
    'https://starbot.cloud',      // Production
    'https://www.starbot.cloud',  // Production (www)
    'https://sgauth0.com',
    'https://www.sgauth0.com',
    'https://console.sgauth0.com',
    'https://www.console.sgauth0.com',
    'https://console.starbot.cloud',
    'https://www.console.starbot.cloud',
    'http://starbot.cloud',       // Production (HTTP before SSL)
    'http://www.starbot.cloud',
    'http://sgauth0.com',
    'http://www.sgauth0.com',
    'http://console.sgauth0.com',
    'http://www.console.sgauth0.com',
    'http://console.starbot.cloud',
    'http://www.console.starbot.cloud',
  ],
  credentials: true,
});

// Auth middleware - decode JWT and set userId on request
server.addHook('onRequest', async (request, reply) => {
  // Skip auth for health endpoints
  if (request.url === '/v1/health' || request.url === '/health') {
    return;
  }

  // Extract token from Authorization header or cookie
  let token: string | undefined;

  // First check Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader) {
    token = authHeader.replace('Bearer ', '').trim();
  }

  // If no header token, check starbot_auth cookie
  if (!token) {
    const cookieHeader = request.headers.cookie;
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').map(c => c.trim());
      const authCookie = cookies.find(c => c.startsWith('starbot_auth='));
      if (authCookie) {
        token = authCookie.substring('starbot_auth='.length);
      }
    }
  }

  if (!token) {
    // Debug: log when no token found
    if (request.url.includes('/chats/main') || request.url.includes('/onboarding')) {
      console.log(`[AUTH DEBUG] No token for ${request.url}. Cookie header:`, request.headers.cookie ? 'present' : 'missing');
    }
    return;
  }

  const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };
    (request as any).userId = decoded.userId;
    (request as any).userEmail = decoded.email;
  } catch (err) {
    // Token invalid - silently continue, individual routes will handle auth
    console.log('[AUTH DEBUG] Token verification failed:', err);
  }
});

// Main health endpoint with /v1 prefix
server.get('/v1/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };
});

// Legacy redirect
server.get('/health', async (request, reply) => {
  return reply.code(301).redirect('/v1/health');
});

// API routes
await server.register(projectRoutes, { prefix: '/v1' });
await server.register(chatRoutes, { prefix: '/v1' });
await server.register(messageRoutes, { prefix: '/v1' });
await server.register(generationRoutes, { prefix: '/v1' });
await server.register(modelRoutes, { prefix: '/v1' });
await server.register(workspaceRoutes, { prefix: '/v1' });
await server.register(memoryRoutes, { prefix: '/v1' });
await server.register(authRoutes, { prefix: '/v1' });
await server.register(inferenceRoutes, { prefix: '/v1' });
await server.register(tasksRoutes, { prefix: '/v1' });
await server.register(folderRoutes, { prefix: '/v1' });
await server.register(calendarRoutes, { prefix: '/v1' });
await server.register(userRoutes, { prefix: '/v1' });
await server.register(onboardingRoutes, { prefix: '/v1' });

// Initialize tools
initializeTools();

// Start server
try {
  await server.listen({ port: PORT, host: HOST });
  console.log(`🧠 Starbot API listening on http://${HOST}:${PORT}`);
  console.log(`📊 Health: http://${HOST}:${PORT}/health`);
  console.log('');
  logConfiguration();
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
