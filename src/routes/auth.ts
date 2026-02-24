import { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db.js';

// Simple password hashing (use bcrypt in production)
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// Generate JWT-like token (use proper JWT in production)
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// In-memory storage for device codes (STUB - use Redis in production)
interface DeviceAuthRequest {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_at: number;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
  access_token?: string;
}

const deviceRequests = new Map<string, DeviceAuthRequest>();

// Helper to generate random codes
function generateCode(length: number): string {
  return crypto.randomBytes(length).toString('hex').slice(0, length).toUpperCase();
}

// Helper to generate user-friendly code
function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  // Format as XXX-XXX
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// Cleanup expired requests every minute
setInterval(() => {
  const now = Date.now();
  for (const [device_code, request] of deviceRequests.entries()) {
    if (request.expires_at < now) {
      request.status = 'expired';
    }
  }
}, 60000);

export const authRoutes: FastifyPluginAsync = async (server) => {
  // Start device authorization flow
  server.post('/auth/device/start', async (request, reply) => {
    const device_code = generateCode(32);
    const user_code = generateUserCode();
    const expires_at = Date.now() + 15 * 60 * 1000; // 15 minutes

    const authRequest: DeviceAuthRequest = {
      device_code,
      user_code,
      verification_url: 'http://localhost:3000/auth/device',
      expires_at,
      status: 'pending',
    };

    deviceRequests.set(device_code, authRequest);

    return {
      device_code,
      user_code,
      verification_url: authRequest.verification_url,
      expires_in: 900, // 15 minutes in seconds
      interval: 5, // Poll every 5 seconds
    };
  });

  // Poll device authorization status
  server.post('/auth/device/poll', async (request, reply) => {
    const { device_code } = request.body as { device_code: string };

    const authRequest = deviceRequests.get(device_code);

    if (!authRequest) {
      return reply.status(404).send({ error: 'Device code not found' });
    }

    if (authRequest.expires_at < Date.now()) {
      authRequest.status = 'expired';
    }

    if (authRequest.status === 'authorized') {
      return {
        status: 'authorized',
        access_token: authRequest.access_token,
      };
    }

    if (authRequest.status === 'denied') {
      return reply.status(403).send({
        error: 'authorization_denied',
        message: 'User denied the authorization request',
      });
    }

    if (authRequest.status === 'expired') {
      return reply.status(410).send({
        error: 'expired_token',
        message: 'Device code has expired',
      });
    }

    return {
      status: 'pending',
      message: 'User has not yet authorized this device',
    };
  });

  // Confirm device authorization (called by WebGUI)
  server.post('/auth/device/confirm', async (request, reply) => {
    const { user_code, action } = request.body as {
      user_code: string;
      action?: 'approve' | 'deny';
    };

    // Find the request with this user code
    let authRequest: DeviceAuthRequest | undefined;
    for (const request of deviceRequests.values()) {
      if (request.user_code === user_code) {
        authRequest = request;
        break;
      }
    }

    if (!authRequest) {
      return reply.status(404).send({ error: 'User code not found' });
    }

    if (authRequest.expires_at < Date.now()) {
      authRequest.status = 'expired';
      return reply.status(410).send({ error: 'Code has expired' });
    }

    if (action === 'deny') {
      authRequest.status = 'denied';
      return { status: 'denied' };
    }

    // Generate access token (simple random token for now)
    const access_token = crypto.randomBytes(32).toString('hex');

    authRequest.status = 'authorized';
    authRequest.access_token = access_token;

    return {
      status: 'authorized',
      message: 'Device authorized successfully',
    };
  });

  // Get pending authorization request (for WebGUI to display)
  server.get('/auth/device/pending/:user_code', async (request, reply) => {
    const { user_code } = request.params as { user_code: string };

    // Find the request with this user code
    let authRequest: DeviceAuthRequest | undefined;
    for (const request of deviceRequests.values()) {
      if (request.user_code === user_code) {
        authRequest = request;
        break;
      }
    }

    if (!authRequest) {
      return reply.status(404).send({ error: 'User code not found' });
    }

    if (authRequest.expires_at < Date.now()) {
      authRequest.status = 'expired';
      return reply.status(410).send({ error: 'Code has expired' });
    }

    return {
      user_code: authRequest.user_code,
      status: authRequest.status,
      expires_in: Math.floor((authRequest.expires_at - Date.now()) / 1000),
    };
  });

  // POST /auth/signup - Create a new user account
  server.post('/auth/signup', async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name?: string;
    };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(password),
        name: name || email.split('@')[0],
      },
    });

    const token = generateToken();

    return reply.status(201).send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    });
  });

  // POST /auth/login - Login with email/password
  server.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password required' });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = generateToken();

    // Store token in database
    await prisma.user.update({
      where: { id: user.id },
      data: { token },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    };
  });

  // GET /auth/me - Get current user info
  server.get('/auth/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return reply.status(401).send({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Find user by token
    const user = await prisma.user.findFirst({
      where: { token },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  });

  // POST /auth/logout - Invalidate current token
  server.post('/auth/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return { success: true };
    }

    const token = authHeader.replace('Bearer ', '');

    // Clear token from user
    await prisma.user.updateMany({
      where: { token },
      data: { token: null },
    });

    return { success: true };
  });
};
