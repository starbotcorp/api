// Environment configuration for Starbot_API
// Load all provider credentials and settings from environment variables

const strEnv = (value: string | undefined, fallback = '') => (value ?? fallback).trim();

// Fix #9: Validate numeric environment variables
function parsePort(value: string | undefined, defaultPort: number): number {
  if (!value) return defaultPort;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid PORT "${value}", using default ${defaultPort}`);
    return defaultPort;
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.error(`Invalid ${name} "${value}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

export const env = {
  // Server
  PORT: parsePort(process.env.PORT, 3737),
  HOST: process.env.HOST || '127.0.0.1',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./prisma/dev.db',

  // Kimi/Moonshot
  MOONSHOT_API_KEY: strEnv(process.env.MOONSHOT_API_KEY),
  MOONSHOT_BASE_URL: strEnv(process.env.MOONSHOT_BASE_URL, 'https://api.moonshot.cn'),

  // Google Vertex AI
  VERTEX_PROJECT_ID: strEnv(process.env.VERTEX_PROJECT_ID),
  VERTEX_LOCATION: strEnv(process.env.VERTEX_LOCATION, 'us-central1'),
  GOOGLE_APPLICATION_CREDENTIALS: strEnv(process.env.GOOGLE_APPLICATION_CREDENTIALS),
  VERTEX_ALLOWED_MODELS: (process.env.VERTEX_ALLOWED_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Azure AI Services
  AZURE_OPENAI_ENDPOINT: strEnv(process.env.AZURE_OPENAI_ENDPOINT),
  AZURE_OPENAI_API_KEY: strEnv(process.env.AZURE_OPENAI_API_KEY),
  AZURE_OPENAI_MODELS: (process.env.AZURE_OPENAI_MODELS || '').split(',').filter(Boolean),
  AZURE_ALLOWED_DEPLOYMENTS: (process.env.AZURE_ALLOWED_DEPLOYMENTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Official DeepSeek API (for testing function calling)
  DEEPSEEK_API_KEY: strEnv(process.env.DEEPSEEK_API_KEY),

  // AWS Bedrock
  AWS_ACCESS_KEY_ID: strEnv(process.env.AWS_ACCESS_KEY_ID),
  AWS_SECRET_ACCESS_KEY: strEnv(process.env.AWS_SECRET_ACCESS_KEY),
  AWS_REGION: strEnv(process.env.AWS_REGION || process.env.BEDROCK_REGION, 'us-east-1'),
  BEDROCK_REGION: strEnv(process.env.BEDROCK_REGION, 'us-east-1'),

  // Cloudflare Workers AI
  CLOUDFLARE_ACCOUNT_ID: strEnv(process.env.CLOUDFLARE_ACCOUNT_ID),
  CLOUDFLARE_API_TOKEN: strEnv(process.env.CLOUDFLARE_API_TOKEN),
  INTERPRETER_ENABLED: process.env.INTERPRETER_ENABLED !== 'false',
  INTERPRETER_MODEL: strEnv(
    process.env.INTERPRETER_MODEL,
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
  ),
  INTERPRETER_MAX_TOKENS: parsePositiveInt(process.env.INTERPRETER_MAX_TOKENS, 220, 'INTERPRETER_MAX_TOKENS'),

  // Codex Router (DISABLED - using DeepSeek directly)
  CODEX_ROUTER_ENABLED: false,
  CODEX_ROUTER_MODEL: strEnv(process.env.CODEX_ROUTER_MODEL, 'DeepSeek-R1'),
  CODEX_ROUTER_MAX_TOKENS: parsePositiveInt(process.env.CODEX_ROUTER_MAX_TOKENS, 300, 'CODEX_ROUTER_MAX_TOKENS'),

  // Triage
  TRIAGE_MODEL_ENABLED: process.env.TRIAGE_MODEL_ENABLED === 'true',

  // Features
  TOOLS_ENABLED: process.env.TOOLS_ENABLED !== 'false', // Default true
  CODE_EXECUTION_ENABLED: process.env.CODE_EXECUTION_ENABLED === 'true', // Default false for security
  SHELL_EXEC_ENABLED: process.env.SHELL_EXEC_ENABLED === 'true', // Default false for security
  WEB_SEARCH_ENABLED: process.env.WEB_SEARCH_ENABLED === 'true',
  WEB_SEARCH_API_KEY: process.env.WEB_SEARCH_API_KEY || '',
  BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY || '',
  WORKSPACE_ROOT: strEnv(process.env.WORKSPACE_ROOT, process.cwd()),
  MEMORY_V2_ENABLED: process.env.MEMORY_V2_ENABLED === 'true',
  AUTH_ENFORCEMENT_ENABLED: process.env.AUTH_ENFORCEMENT_ENABLED === 'true',
  RATE_LIMITING_ENABLED: process.env.RATE_LIMITING_ENABLED === 'true',
  RATE_LIMIT_WINDOW_MS: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60000, 'RATE_LIMIT_WINDOW_MS'),
  RATE_LIMIT_RUN_PER_WINDOW: parsePositiveInt(process.env.RATE_LIMIT_RUN_PER_WINDOW, 8, 'RATE_LIMIT_RUN_PER_WINDOW'),
  RATE_LIMIT_MESSAGES_PER_WINDOW: parsePositiveInt(process.env.RATE_LIMIT_MESSAGES_PER_WINDOW, 100, 'RATE_LIMIT_MESSAGES_PER_WINDOW'),
  RATE_LIMIT_INFERENCE_PER_WINDOW: parsePositiveInt(process.env.RATE_LIMIT_INFERENCE_PER_WINDOW, 30, 'RATE_LIMIT_INFERENCE_PER_WINDOW'),
  RATE_LIMIT_COMPLETION_PER_WINDOW: parsePositiveInt(
    process.env.RATE_LIMIT_COMPLETION_PER_WINDOW,
    60,
    'RATE_LIMIT_COMPLETION_PER_WINDOW',
  ),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// Validation helpers
export function isProviderConfigured(provider: string): boolean {
  switch (provider) {
    case 'kimi':
      return !!env.MOONSHOT_API_KEY;
    case 'vertex':
      return !!env.VERTEX_PROJECT_ID;
    case 'azure':
      return !!env.AZURE_OPENAI_ENDPOINT && !!env.AZURE_OPENAI_API_KEY;
    case 'bedrock':
      return !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY;
    case 'cloudflare':
      return !!env.CLOUDFLARE_ACCOUNT_ID && !!env.CLOUDFLARE_API_TOKEN;
    case 'deepseek':
      return !!env.DEEPSEEK_API_KEY;
    default:
      return false;
  }
}

export function listConfiguredProviders(): string[] {
  const providers = ['kimi', 'vertex', 'azure', 'bedrock', 'cloudflare'];
  return providers.filter(isProviderConfigured);
}

// Log configuration on startup (redact secrets)
export function logConfiguration() {
  const configured = listConfiguredProviders();
  console.log('Starbot_API Configuration:');
  console.log(`  Environment: ${env.NODE_ENV}`);
  console.log(`  Server: ${env.HOST}:${env.PORT}`);
  console.log(`  Configured providers: ${configured.join(', ') || 'none'}`);
  console.log(`  Tools enabled: ${env.TOOLS_ENABLED}`);
  if (env.CODE_EXECUTION_ENABLED) {
    console.log(`  ⚠️  CODE EXECUTION ENABLED - Use with caution!`);
  }
  console.log(`  Web search enabled: ${env.WEB_SEARCH_ENABLED}`);
  console.log(`  Memory V2 enabled: ${env.MEMORY_V2_ENABLED}`);
  console.log(`  Codex router enabled: ${env.CODEX_ROUTER_ENABLED}`);
  console.log(`  Codex router model: ${env.CODEX_ROUTER_MODEL}`);
  console.log(`  Interpreter enabled: ${env.INTERPRETER_ENABLED}`);
  console.log(`  Interpreter model: ${env.INTERPRETER_MODEL}`);
  console.log(`  Triage model enabled: ${env.TRIAGE_MODEL_ENABLED}`);
  console.log(`  Auth enforcement enabled: ${env.AUTH_ENFORCEMENT_ENABLED}`);
  console.log(`  Rate limiting enabled: ${env.RATE_LIMITING_ENABLED}`);
  if (env.RATE_LIMITING_ENABLED) {
    console.log(`  Rate limit window ms: ${env.RATE_LIMIT_WINDOW_MS}`);
    console.log(`  /run max per window: ${env.RATE_LIMIT_RUN_PER_WINDOW}`);
    console.log(`  /inference/chat max per window: ${env.RATE_LIMIT_INFERENCE_PER_WINDOW}`);
  }
}
