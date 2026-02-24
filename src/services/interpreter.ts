import { env } from '../env.js';
import { getProvider } from '../providers/index.js';

export type InterpreterIntent = 'chat' | 'browse' | 'filesystem' | 'code' | 'shell' | 'tool' | 'clarify';

export interface InterpretationResult {
  shouldClarify: boolean;
  clarificationQuestion?: string;
  normalizedUserMessage: string;
  primaryIntent: InterpreterIntent;
  intents: InterpreterIntent[];
  confidence: number;
  reason?: string;
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function normalizeIntent(raw: unknown): InterpreterIntent | null {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'clarify') return 'clarify';
  if (['browse', 'web', 'web_search', 'research', 'search'].includes(value)) return 'browse';
  if (
    ['filesystem', 'files', 'file', 'directory', 'workspace', 'repo', 'folder', 'local', 'glob', 'grep'].includes(
      value,
    )
  ) {
    return 'filesystem';
  }
  if (['shell', 'terminal', 'command', 'exec', 'bash', 'sh'].includes(value)) return 'shell';
  if (['code', 'coding', 'programming', 'edit', 'refactor', 'debug'].includes(value)) {
    return 'code';
  }
  if (['tool', 'tools', 'function', 'function_call', 'action'].includes(value)) return 'tool';
  if (['chat', 'general', 'qa', 'question'].includes(value)) return 'chat';
  return null;
}

function dedupeIntents(intents: InterpreterIntent[]): InterpreterIntent[] {
  const out: InterpreterIntent[] = [];
  for (const intent of intents) {
    if (!out.includes(intent)) out.push(intent);
  }
  return out;
}

function heuristicIntents(message: string): InterpreterIntent[] {
  const text = message.toLowerCase();
  const intents: InterpreterIntent[] = [];

  // Filesystem intent detection (including write/edit/save operations)
  if (
    /\b(ls|pwd|cat|mkdir|rm|cp|mv)\b/.test(text) ||
    text.includes('directory') ||
    text.includes('folder') ||
    text.includes('files in') ||
    text.includes('file list') ||
    text.includes('workspace') ||
    text.includes('open file') ||
    text.includes('read file') ||
    text.includes('save as') ||
    text.includes('write to') ||
    text.includes('create file') ||
    text.includes('delete file') ||
    // Write/save/edit operations
    text.includes('save file') ||
    text.includes('save this') ||
    text.includes('write file') ||
    text.includes('create new file') ||
    text.includes('edit file') ||
    text.includes('modify file') ||
    text.includes('update file') ||
    text.includes('change file') ||
    text.includes('replace in file') ||
    text.includes('patch file') ||
    text.includes('make file') ||
    text.includes('generate file') ||
    text.includes('create a') && (text.includes('file') || text.includes('script')) ||
    text.includes('write code') ||
    /\b(show|list|display)\s+(files?|contents?)\b/i.test(text)
  ) {
    intents.push('filesystem');
  }

  // Browse/web search intent detection
  if (
    text.includes('browse') ||
    text.includes('search the web') ||
    text.includes('search online') ||
    text.includes('look up online') ||
    text.includes('find online') ||
    text.includes('google') ||
    text.includes('look up') ||
    text.includes('latest') ||
    text.includes('news') ||
    text.includes('current') ||
    text.includes('today') ||
    /what(?:'s| is) the (?:weather|time|date|price)/i.test(text)
  ) {
    intents.push('browse');
  }

  // Shell/terminal intent detection
  if (
    text.includes('run ') ||
    text.includes('execute ') ||
    text.includes('build') ||
    text.includes('test') ||
    text.includes('install') ||
    text.includes('npm ') ||
    text.includes('yarn ') ||
    text.includes('pnpm ') ||
    text.includes('git ') ||
    text.includes('docker ') ||
    text.includes('kubectl ') ||
    text.includes('curl ') ||
    text.includes('compile') ||
    text.includes('deploy') ||
    text.startsWith('cd ') ||
    text.startsWith('ls ') ||
    text.startsWith('rm ') ||
    text.startsWith('mv ') ||
    text.startsWith('cp ')
  ) {
    intents.push('shell');
  }

  // Code intent detection
  if (
    text.includes('code') ||
    text.includes('debug') ||
    text.includes('refactor') ||
    text.includes('fix this')
  ) {
    intents.push('code');
  }

  if (intents.length === 0) intents.push('chat');
  return dedupeIntents(intents);
}

export async function interpretUserMessage(message: string): Promise<InterpretationResult> {
  const original = String(message || '').trim();
  if (!original) {
    return {
      shouldClarify: true,
      clarificationQuestion: 'What would you like me to do?',
      normalizedUserMessage: '',
      primaryIntent: 'clarify',
      intents: ['clarify'],
      confidence: 1,
      reason: 'empty_message',
    };
  }

  if (!env.INTERPRETER_ENABLED) {
    const intents = heuristicIntents(original);
    return {
      shouldClarify: false,
      normalizedUserMessage: original,
      primaryIntent: intents[0] || 'chat',
      intents,
      confidence: 1,
      reason: 'interpreter_disabled',
    };
  }

  try {
    const provider = getProvider('cloudflare');
    const response = await provider.sendChat(
      [
        {
          role: 'system',
          content:
            'You are a request interpreter and router for a Codex-like AI coding assistant. Return JSON only.\n\n' +
            'Schema: {"action":"execute|clarify","primary_intent":"chat|browse|filesystem|code|shell|tool|clarify","intents":["chat|browse|filesystem|code|shell|tool|clarify"],"normalized_user_message":"string","clarification_question":"string","confidence":0..1,"reason":"string"}\n\n' +
            'INSTRUCTIONS:\n' +
            '- Use primary_intent=shell for terminal commands, git operations, npm/yarn/pnpm, build commands, tests\n' +
            '- Use primary_intent=browse for web lookup/research/current info requests\n' +
            '- Use primary_intent=filesystem for file operations: glob (find files), grep (search in files), read, write, edit files\n' +
            '- Use primary_intent=code for debugging/refactoring/programming tasks that require code generation\n' +
            '- Use primary_intent=chat for general knowledge/explanation questions (default)\n' +
            '- Use action=clarify only when critical details are missing\n\n' +
            'KEYWORD MAPPINGS:\n' +
            '- "find all", "where is", "search for", "look for" -> filesystem (use grep/glob)\n' +
            '- "run", "execute", "build", "test", "install", "git" -> shell\n' +
            '- "create", "write", "save", "edit", "modify" -> filesystem (write/edit tools)\n' +
            '- "list files", "ls", "directory", "folder" -> filesystem (glob/ls)\n' +
            '- "web", "online", "latest", "news" -> browse\n\n' +
            'EXAMPLES:\n\n' +
            '{"action":"execute","primary_intent":"shell","intents":["shell"],"normalized_user_message":"Run npm run build","confidence":0.98,"reason":"build_command"}\n\n' +
            '{"action":"execute","primary_intent":"filesystem","intents":["filesystem"],"normalized_user_message":"Find all TypeScript files in src/","confidence":0.95,"reason":"glob_pattern"}\n\n' +
            '{"action":"execute","primary_intent":"filesystem","intents":["filesystem"],"normalized_user_message":"Search for function authenticate in the codebase","confidence":0.95,"reason":"grep_search"}\n\n' +
            '{"action":"execute","primary_intent":"filesystem","intents":["filesystem"],"normalized_user_message":"Create a new file hello.py with print hello world","confidence":0.98,"reason":"file_creation"}\n\n' +
            '{"action":"execute","primary_intent":"browse","intents":["browse"],"normalized_user_message":"What\'s the weather in Paris?","confidence":0.95,"reason":"current_info_needed"}\n\n' +
            '{"action":"execute","primary_intent":"filesystem","intents":["filesystem"],"normalized_user_message":"List files in src/","confidence":0.98,"reason":"filesystem_command"}\n\n' +
            '{"action":"execute","primary_intent":"code","intents":["code"],"normalized_user_message":"Fix the bug in main.ts","confidence":0.85,"reason":"code_modification"}\n\n' +
            '{"action":"execute","primary_intent":"chat","intents":["chat"],"normalized_user_message":"Explain recursion","confidence":0.9,"reason":"knowledge_query"}\n\n' +
            '{"action":"clarify","primary_intent":"clarify","intents":["clarify"],"clarification_question":"What would you like me to do? Please provide more context.","confidence":0.4,"reason":"ambiguous_request"}\n\n' +
            'Now classify this request:',
        },
        {
          role: 'user',
          content: `${original}`,
        },
      ],
      {
        model: env.INTERPRETER_MODEL,
        maxTokens: env.INTERPRETER_MAX_TOKENS,
        temperature: 0.1,
      },
    );

    const jsonText = extractJsonObject(response.content);
    if (!jsonText) {
      const intents = heuristicIntents(original);
      return {
        shouldClarify: false,
        normalizedUserMessage: original,
        primaryIntent: intents[0] || 'chat',
        intents,
        confidence: 0.35,
        reason: 'interpreter_non_json',
      };
    }

    const parsed = JSON.parse(jsonText) as {
      action?: string;
      primary_intent?: string;
      intent?: string;
      intents?: string[];
      normalized_user_message?: string;
      clarification_question?: string;
      confidence?: number;
      reason?: string;
    };

    const action = String(parsed.action || 'execute').trim().toLowerCase();
    const normalized = String(parsed.normalized_user_message || '').trim() || original;
    const clarification = String(parsed.clarification_question || '').trim();
    const intents = dedupeIntents(
      [
        normalizeIntent(parsed.primary_intent),
        normalizeIntent(parsed.intent),
        ...((Array.isArray(parsed.intents) ? parsed.intents : []).map((v) => normalizeIntent(v))),
      ].filter((v): v is InterpreterIntent => !!v),
    );
    const fallbackIntents = intents.length > 0 ? intents : heuristicIntents(normalized);
    const primaryIntent =
      normalizeIntent(parsed.primary_intent) || fallbackIntents[0] || (action === 'clarify' ? 'clarify' : 'chat');

    const lowerOriginal = original.toLowerCase();
    const explicitFilesystemSignal =
      /\b(ls|pwd)\b/.test(lowerOriginal) ||
      lowerOriginal.includes('directory') ||
      lowerOriginal.includes('folder') ||
      lowerOriginal.includes('files') ||
      lowerOriginal.includes('contents') ||
      lowerOriginal.includes('working directory') ||
      lowerOriginal.includes('current directory');
    const heuristicSuggestsFilesystem = fallbackIntents.includes('filesystem');
    const weakClarifyForFilesystem =
      action === 'clarify' && explicitFilesystemSignal && heuristicSuggestsFilesystem;

    if (weakClarifyForFilesystem) {
      return {
        shouldClarify: false,
        normalizedUserMessage: normalized,
        primaryIntent: 'filesystem',
        intents: dedupeIntents(['filesystem', ...fallbackIntents.filter((v) => v !== 'clarify')]),
        confidence: clampConfidence(parsed.confidence, 0.65),
        reason: 'clarify_overridden_filesystem_heuristic',
      };
    }

    if (action === 'clarify' && clarification) {
      return {
        shouldClarify: true,
        clarificationQuestion: clarification,
        normalizedUserMessage: normalized,
        primaryIntent: 'clarify',
        intents: dedupeIntents(['clarify', ...fallbackIntents]),
        confidence: clampConfidence(parsed.confidence, 0.7),
        reason: parsed.reason,
      };
    }

    return {
      shouldClarify: false,
      normalizedUserMessage: normalized,
      primaryIntent,
      intents: fallbackIntents,
      confidence: clampConfidence(parsed.confidence, 0.8),
      reason: parsed.reason,
    };
  } catch (error) {
    const intents = heuristicIntents(original);
    return {
      shouldClarify: false,
      normalizedUserMessage: original,
      primaryIntent: intents[0] || 'chat',
      intents,
      confidence: 0.25,
      reason: `interpreter_error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
