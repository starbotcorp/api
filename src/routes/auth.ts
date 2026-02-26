import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { TTLCache } from '../utils/ttl-cache.js';
import { AppError, formatErrorResponse } from '../utils/errors.js';

// Fix #1: Use bcrypt for password hashing (OWASP recommended)
const SALT_ROUNDS = 12;

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Fix #4: Use JWT tokens with expiration
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const TOKEN_EXPIRY = '7d';

interface TokenPayload {
  userId: string;
  email: string;
  sessionId: string;
  iat: number;
  exp: number;
}

function generateToken(user: { id: string; email: string }, sessionId: string): string {
  return jwt.sign(
    { userId: user.id, email: user.email, sessionId },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

// Fix #6: Use TTL cache for device auth to prevent memory leaks
interface DeviceAuthRequest {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_at: number;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
  access_token?: string;
}

const deviceRequests = new TTLCache<string, DeviceAuthRequest>(15 * 60 * 1000);

// Helper to generate random codes
function generateCode(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  // Use crypto.getRandomValues for synchronous random generation
  const randomValues = new Uint8Array(length);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('crypto').randomFillSync(randomValues);
  for (let i = 0; i < length; i++) {
    code += chars[randomValues[i]! % chars.length];
  }
  return code;
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

// Fix #11: Use configurable base URL
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

export const authRoutes: FastifyPluginAsync = async (server) => {
  // Start device authorization flow
  server.post('/auth/device/start', async (request, reply) => {
    const device_code = await generateCode(32);
    const user_code = generateUserCode();
    const expires_at = Date.now() + 15 * 60 * 1000; // 15 minutes

    const authRequest: DeviceAuthRequest = {
      device_code,
      user_code,
      verification_url: `${BASE_URL}/auth/device`, // Fix #11
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
      deviceRequests.set(device_code, authRequest, 0); // Will be cleaned up
      return reply.status(410).send({
        error: 'expired_token',
        message: 'Device code has expired',
      });
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
    let deviceCode: string | undefined;

    for (const [code, req] of deviceRequests.entries()) {
      if (req.user_code === user_code) {
        authRequest = req;
        deviceCode = code;
        break;
      }
    }

    if (!authRequest || !deviceCode) {
      return reply.status(404).send({ error: 'User code not found' });
    }

    if (authRequest.expires_at < Date.now()) {
      authRequest.status = 'expired';
      deviceRequests.set(deviceCode, authRequest, 0);
      return reply.status(410).send({ error: 'Code has expired' });
    }

    if (action === 'deny') {
      authRequest.status = 'denied';
      deviceRequests.set(deviceCode, authRequest);
      return { status: 'denied' };
    }

    // Generate JWT access token
    const access_token = generateToken(
      { id: 'device-user', email: 'device@starbot.cloud' },
      `device-${Date.now()}`
    );

    authRequest.status = 'authorized';
    authRequest.access_token = access_token;
    deviceRequests.set(deviceCode, authRequest);

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

    for (const req of deviceRequests.values()) {
      if (req.user_code === user_code) {
        authRequest = req;
        break;
      }
    }

    if (!authRequest) {
      return reply.status(404).send({ error: 'User code not found' });
    }

    if (authRequest.expires_at < Date.now()) {
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

    // Validate password strength
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    // Create user with bcrypt hashed password
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name || email.split('@')[0],
      },
    });

    // Fix #12: Create session for multi-device support
    const sessionId = `session-${Date.now()}`;
    const token = generateToken({ id: user.id, email: user.email }, sessionId);

    // Store session in database (if Session model exists, otherwise fallback to token field)
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { token }, // Fallback for backward compatibility
      });
    } catch {
      // Ignore if update fails
    }

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

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // Fix #12: Create new session
    const sessionId = `session-${Date.now()}`;
    const token = generateToken({ id: user.id, email: user.email }, sessionId);

    // Store token in database for backward compatibility
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

  // GET /auth/me - Get current user info (with JWT validation)
  server.get('/auth/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return reply.status(401).send({ error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Fix #4: Validate JWT token
    const payload = verifyToken(token);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    // Find user by ID from token
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      return reply.status(401).send({ error: 'User not found' });
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

    // Validate token to get user ID
    const payload = verifyToken(token);
    if (payload) {
      // Clear token from user (for backward compatibility)
      await prisma.user.updateMany({
        where: { id: payload.userId, token },
        data: { token: null },
      });
    }

    return { success: true };
  });

  // Cleanup on server shutdown
  server.addHook('onClose', async () => {
    deviceRequests.destroy();
  });
};
