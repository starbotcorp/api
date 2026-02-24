/**
 * Message Pre-Processor Service
 *
 * EVERY user message goes through this before routing.
 * Uses Codex Mini (cheap, fast) to:
 * 1. Classify intent
 * 2. Identify required tools/models
 * 3. Extract entities
 * 4. Attach structured header for downstream routing + memory/search
 */

import { env } from '../env.js';
import { getProvider } from '../providers/index.js';

// ============================================================================
// PROTOCOL DEFINITION
// ============================================================================

export interface StarBotMeta {
  // Primary intent classification
  intent: string;           // e.g., "filesystem/create", "shell/run", "chat/explain"

  // Tool routing
  tools: string[];          // e.g., ["fs-write-file", "fs-glob"]

  // Model selection hint
  model_tier: 'quick' | 'standard' | 'deep';

  // Extracted entities from the message
  entities: Record<string, string | string[] | undefined>;

  // How confident is the classification (0-1)
  confidence: number;

  // Human-readable summary of what the user wants
  context_hint: string;

  // Original user message (preserved)
  original_message: string;

  // Timestamp for cataloging
  timestamp: string;

  // Optional: conversation context summary (for multi-turn)
  conversation_context?: string;
}

export interface PreprocessedMessage {
  meta: StarBotMeta;
  enriched_message: string;  // Original message with header attached
  raw_message: string;       // Original message unchanged
}

// ============================================================================
// AVAILABLE TOOLS & MODELS (for the pre-processor prompt)
// ============================================================================

const AVAILABLE_TOOLS = `
FILESYSTEM TOOLS:
- fs-write-file: Create or overwrite a file with content
- fs-edit-file: Edit specific parts of an existing file
- fs-read-file: Read contents of a file
- fs-glob: Find files matching a pattern (e.g., "*.ts", "src/**/*.js")
- fs-grep: Search for text/patterns within files
- fs-advanced-ops: Move, copy, rename, delete files/directories

SHELL TOOLS:
- shell-exec: Run terminal commands (git, npm, build, etc.)

CODE TOOLS:
- code-exec: Execute code snippets (Python, JS, etc.)

WEB TOOLS:
- web-search: Search the internet for information

CALCULATOR:
- calculator: Evaluate math expressions
`;

const MODEL_TIERS = `
MODEL TIERS:
- quick: Simple tasks, fast responses (listing files, simple questions, file creation)
- standard: Medium complexity (code explanation, moderate analysis)
- deep: Complex tasks (debugging, architecture design, long code generation)
`;

// ============================================================================
// THE PRE-PROCESSOR PROMPT
// ============================================================================

const PREPROCESSOR_SYSTEM_PROMPT = `You are a message pre-processor for StarBot, an AI coding assistant.

YOUR JOB: Analyze every user message and output a JSON classification header.
⚠️ CRITICAL: ALWAYS EXECUTE. NEVER ask for clarification unless the message is literally gibberish.

${AVAILABLE_TOOLS}

${MODEL_TIERS}

OUTPUT FORMAT (JSON only, no markdown):
{
  "intent": "category/action",
  "tools": ["tool1", "tool2"],
  "model_tier": "quick|standard|deep",
  "entities": {"key": "value"},
  "confidence": 0.0-1.0,
  "context_hint": "brief description of what user wants"
}

INTENT CATEGORIES:
- filesystem/list: List directory contents ("ls", "what's in X", "show files", "look into X")
- filesystem/create: Create new file ("create html file", "new python script", "make a file", "just an html doc")
- filesystem/read: Read file contents ("show me X.ts", "cat file", "open file")
- filesystem/edit: Modify existing file ("change X", "update the function", "edit file")
- filesystem/search: Find files or content ("find all .ts files", "search for X", "grep")
- filesystem/navigate: Navigate directories ("parent dir", "go up", "cd ..", "directory above")
- shell/run: Execute commands ("run npm build", "git status", "npm install")
- code/generate: Write new code ("write a function that...", "create a class")
- code/explain: Explain code ("what does this do", "explain this function")
- code/debug: Fix bugs ("why doesn't this work", "fix the error")
- chat/explain: General knowledge ("what is X", "how does Y work")
- chat/general: Casual conversation, greetings
- web/search: Internet lookup ("latest news on", "search for")

ENTITY EXTRACTION:
- file_type: html, css, js, ts, py, json, md, txt, yaml, sh, etc.
- file_path: any mentioned file paths
- folder_name: any mentioned folder/directory names (scripts, src, deploy, lib, etc.)
- command: shell commands to run
- search_query: what to search for
- language: programming language mentioned

🔥 AGGRESSIVE MATCHING RULES - SNAP TO INTENT:

1. FILE CREATION - if ANY of these patterns, intent = filesystem/create:
   - "create/make/new/generate [anything] file/doc/script"
   - "just a/an [filetype]" → e.g., "just an html doc" = create HTML
   - Single file type word: "html", "python", "css" after discussion of creating
   - "create a new one" = create (infer type from context or use txt)
   - "program", "script", "document" = create

2. DIRECTORY LISTING - if ANY of these patterns, intent = filesystem/list:
   - "what's in X", "whats in X", "what is in X"
   - "look into X", "look at X", "look in X", "check X"
   - "show me X", "show X" (where X is folder name)
   - Bare folder names: "scripts", "src", "deploy", "lib", "dist", "node_modules"
   - "ls", "ls X", "list X"

3. DIRECTORY NAVIGATION - intent = filesystem/navigate:
   - "parent", "above", "go up", "one up", ".."
   - "directory above", "folder above"

4. SHELL COMMANDS - intent = shell/run:
   - Starts with: npm, yarn, git, docker, kubectl, cargo, pip, python
   - Contains: run, build, test, install, deploy, compile

CONFIDENCE GUIDE:
- 0.95+: Clear match (create html file, ls src, npm install)
- 0.85+: Good match with minor inference (just an html, look in scripts)
- 0.70+: Reasonable guess (create a new one, look at that)
- 0.50+: Uncertain but actionable (vague verbs, pronouns without context)
- <0.50: Only for actual gibberish

EXAMPLES:

"just an html doc"
{"intent":"filesystem/create","tools":["fs-write-file"],"model_tier":"quick","entities":{"file_type":"html"},"confidence":0.95,"context_hint":"Create new HTML file"}

"what's in scripts"
{"intent":"filesystem/list","tools":[],"model_tier":"quick","entities":{"folder_name":"scripts"},"confidence":0.98,"context_hint":"List scripts folder contents"}

"look into src"
{"intent":"filesystem/list","tools":[],"model_tier":"quick","entities":{"folder_name":"src"},"confidence":0.95,"context_hint":"List src folder contents"}

"directory above"
{"intent":"filesystem/navigate","tools":[],"model_tier":"quick","entities":{"direction":"parent"},"confidence":0.95,"context_hint":"Navigate to parent directory"}

"create a new one"
{"intent":"filesystem/create","tools":["fs-write-file"],"model_tier":"quick","entities":{},"confidence":0.75,"context_hint":"Create new file (type to be determined)"}

"npm test"
{"intent":"shell/run","tools":["shell-exec"],"model_tier":"quick","entities":{"command":"npm test"},"confidence":0.99,"context_hint":"Run npm test"}

"html"
{"intent":"filesystem/create","tools":["fs-write-file"],"model_tier":"quick","entities":{"file_type":"html"},"confidence":0.85,"context_hint":"Create HTML file (inferred from context)"}

"explain how async works"
{"intent":"chat/explain","tools":[],"model_tier":"standard","entities":{"topic":"async"},"confidence":0.95,"context_hint":"Explain async concept"}

Now classify:`;

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

function parsePreprocessorResponse(response: string): Partial<StarBotMeta> | null {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      intent: parsed.intent || 'chat/general',
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      model_tier: ['quick', 'standard', 'deep'].includes(parsed.model_tier) ? parsed.model_tier : 'standard',
      entities: typeof parsed.entities === 'object' ? parsed.entities : {},
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      context_hint: parsed.context_hint || '',
    };
  } catch {
    return null;
  }
}

function buildFallbackMeta(message: string): Partial<StarBotMeta> {
  // Heuristic fallback when LLM fails - BE AGGRESSIVE
  const lower = message.toLowerCase().trim();
  const original = message.trim();

  // 1. FILE CREATION - very aggressive matching
  const fileTypes = 'html|htm|css|js|javascript|ts|typescript|py|python|json|yaml|yml|md|markdown|txt|text|xml|csv|sh|bash|sql|go|rust|rs|java|c|cpp|rb|ruby|php|swift|kotlin';
  const createPatterns = [
    // "create a/an X file", "make new X", etc.
    new RegExp(`\\b(create|make|new|generate|write)\\s+(a\\s+)?(an\\s+)?(new\\s+)?(${fileTypes})\\s*(file|doc|document|script|page)?\\b`, 'i'),
    // "just a/an X"
    new RegExp(`\\bjust\\s+(a|an)\\s+(${fileTypes})\\s*(file|doc|document|script|page)?\\b`, 'i'),
    // Bare file type with context: "html", "python" (when short message)
    new RegExp(`^(${fileTypes})\\s*(file|doc)?$`, 'i'),
    // "create a file/program/script/document"
    /\b(create|make|new)\s+(a\s+)?(an\s+)?(new\s+)?(file|program|script|document|doc|page)\b/i,
    // "create a new one"
    /\b(create|make)\s+(a\s+)?(new\s+)?one\b/i,
  ];

  for (const pattern of createPatterns) {
    if (pattern.test(lower)) {
      const fileTypeMatch = lower.match(new RegExp(`\\b(${fileTypes})\\b`, 'i'));
      return {
        intent: 'filesystem/create',
        tools: ['fs-write-file'],
        model_tier: 'quick',
        entities: fileTypeMatch ? { file_type: fileTypeMatch[1].toLowerCase() } : {},
        confidence: fileTypeMatch ? 0.9 : 0.75,
        context_hint: fileTypeMatch
          ? `Create new ${fileTypeMatch[1].toUpperCase()} file`
          : 'Create new file (type to be determined)',
      };
    }
  }

  // 2. DIRECTORY NAVIGATION - parent, above, go up
  if (/\b(parent|above|go\s*up|one\s*up|\.\.)\b/i.test(lower) ||
      /\b(directory|folder|dir)\s*(above|up)\b/i.test(lower)) {
    return {
      intent: 'filesystem/navigate',
      tools: [],
      model_tier: 'quick',
      entities: { direction: 'parent' },
      confidence: 0.9,
      context_hint: 'Navigate to parent directory',
    };
  }

  // 3. DIRECTORY LISTING - what's in X, look into X, show X, ls X
  const listPatterns = [
    /\b(what'?s?\s+in|whats\s+in|what\s+is\s+in)\s+(.+)$/i,
    /\b(look\s*(in|into|at)|check|show\s*(me)?)\s+(the\s+)?(\w+)\s*(folder|directory|dir)?$/i,
    /^ls\s+(.+)$/i,
    /^ls$/i,
  ];

  // Common folder names
  const folderNames = ['scripts', 'src', 'deploy', 'lib', 'dist', 'build', 'node_modules', 'config', 'test', 'tests', 'spec', 'docs', 'public', 'assets', 'static', 'components', 'services', 'utils', 'helpers', 'routes', 'views', 'models', 'controllers'];

  for (const pattern of listPatterns) {
    const match = original.match(pattern);
    if (match) {
      // Extract the folder name from the match
      const lastGroup = match[match.length - 1]?.trim() || match[1]?.trim();
      const folderMatch = lastGroup?.match(/\b(\w+)\b/);
      const folder = folderMatch?.[1];

      return {
        intent: 'filesystem/list',
        tools: [],
        model_tier: 'quick',
        entities: folder ? { folder_name: folder } : {},
        confidence: 0.9,
        context_hint: folder ? `List contents of ${folder} folder` : 'List current directory',
      };
    }
  }

  // Check for bare folder name mention (e.g., just "scripts" or "src")
  const singleWordFolder = folderNames.find(f => lower === f || lower === f + '/');
  if (singleWordFolder) {
    return {
      intent: 'filesystem/list',
      tools: [],
      model_tier: 'quick',
      entities: { folder_name: singleWordFolder },
      confidence: 0.8,
      context_hint: `List contents of ${singleWordFolder} folder`,
    };
  }

  // 4. SHELL COMMANDS - npm, yarn, git, etc.
  const shellPrefixes = ['npm', 'yarn', 'pnpm', 'git', 'docker', 'kubectl', 'cargo', 'pip', 'python', 'node', 'bun', 'deno'];
  if (shellPrefixes.some(p => lower.startsWith(p + ' ') || lower === p)) {
    return {
      intent: 'shell/run',
      tools: ['shell-exec'],
      model_tier: 'quick',
      entities: { command: original },
      confidence: 0.95,
      context_hint: `Run command: ${original}`,
    };
  }

  if (/\b(run|execute|build|test|install|deploy|compile)\b/i.test(lower)) {
    return {
      intent: 'shell/run',
      tools: ['shell-exec'],
      model_tier: 'quick',
      entities: {},
      confidence: 0.75,
      context_hint: 'Run shell command',
    };
  }

  // 5. WEB SEARCH
  if (/\b(search|google|look\s*up|find\s+online|latest|news|current)\b/i.test(lower) &&
      !lower.includes('file') && !lower.includes('folder')) {
    return {
      intent: 'web/search',
      tools: ['web-search'],
      model_tier: 'quick',
      entities: { search_query: original },
      confidence: 0.8,
      context_hint: 'Web search',
    };
  }

  // 6. DEFAULT: Chat/general - but still high confidence to avoid clarification
  return {
    intent: 'chat/general',
    tools: [],
    model_tier: 'standard',
    entities: {},
    confidence: 0.7, // High enough to avoid clarification
    context_hint: 'General conversation or query',
  };
}

function formatMetaHeader(meta: StarBotMeta): string {
  return [
    '[STARBOT-META]',
    `intent: ${meta.intent}`,
    `tools: [${meta.tools.join(', ')}]`,
    `model_tier: ${meta.model_tier}`,
    `entities: ${JSON.stringify(meta.entities)}`,
    `confidence: ${meta.confidence}`,
    `context_hint: ${meta.context_hint}`,
    `timestamp: ${meta.timestamp}`,
    '[/STARBOT-META]',
  ].join('\n');
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export async function preprocessMessage(
  message: string,
  conversationContext?: string,
): Promise<PreprocessedMessage> {
  const timestamp = new Date().toISOString();

  let metaPartial: Partial<StarBotMeta>;

  // Try LLM classification
  if (env.INTERPRETER_ENABLED) {
    try {
      const provider = getProvider('cloudflare');
      const response = await provider.sendChat(
        [
          { role: 'system', content: PREPROCESSOR_SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        {
          model: env.INTERPRETER_MODEL,
          maxTokens: 300,
          temperature: 0.1,
        },
      );

      const parsed = parsePreprocessorResponse(response.content);
      metaPartial = parsed || buildFallbackMeta(message);
    } catch {
      metaPartial = buildFallbackMeta(message);
    }
  } else {
    metaPartial = buildFallbackMeta(message);
  }

  // Build complete meta object
  const meta: StarBotMeta = {
    intent: metaPartial.intent || 'chat/general',
    tools: metaPartial.tools || [],
    model_tier: metaPartial.model_tier || 'standard',
    entities: metaPartial.entities || {},
    confidence: metaPartial.confidence || 0.5,
    context_hint: metaPartial.context_hint || '',
    original_message: message,
    timestamp,
    conversation_context: conversationContext,
  };

  // Build enriched message with header
  const header = formatMetaHeader(meta);
  const enriched_message = `${header}\n\n${message}`;

  return {
    meta,
    enriched_message,
    raw_message: message,
  };
}

// ============================================================================
// UTILITY: Parse header from enriched message
// ============================================================================

export function parseMetaFromMessage(message: string): StarBotMeta | null {
  const headerMatch = message.match(/\[STARBOT-META\]([\s\S]*?)\[\/STARBOT-META\]/);
  if (!headerMatch) return null;

  const headerContent = headerMatch[1];

  try {
    const intentMatch = headerContent.match(/intent:\s*(.+)/);
    const toolsMatch = headerContent.match(/tools:\s*\[([^\]]*)\]/);
    const tierMatch = headerContent.match(/model_tier:\s*(\w+)/);
    const entitiesMatch = headerContent.match(/entities:\s*(\{.*\})/);
    const confidenceMatch = headerContent.match(/confidence:\s*([\d.]+)/);
    const contextMatch = headerContent.match(/context_hint:\s*(.+)/);
    const timestampMatch = headerContent.match(/timestamp:\s*(.+)/);

    const tools = toolsMatch?.[1]
      ? toolsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : [];

    return {
      intent: intentMatch?.[1]?.trim() || 'chat/general',
      tools,
      model_tier: (tierMatch?.[1]?.trim() as 'quick' | 'standard' | 'deep') || 'standard',
      entities: entitiesMatch?.[1] ? JSON.parse(entitiesMatch[1]) : {},
      confidence: confidenceMatch?.[1] ? parseFloat(confidenceMatch[1]) : 0.5,
      context_hint: contextMatch?.[1]?.trim() || '',
      original_message: message.replace(/\[STARBOT-META\][\s\S]*?\[\/STARBOT-META\]\n*/g, '').trim(),
      timestamp: timestampMatch?.[1]?.trim() || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// UTILITY: Quick intent check helpers
// ============================================================================

export function isFilesystemIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('filesystem/');
}

export function isShellIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('shell/');
}

export function isCodeIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('code/');
}

export function isChatIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('chat/');
}

export function isWebIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('web/');
}

export function isBrowseIntent(meta: StarBotMeta): boolean {
  return meta.intent.startsWith('web/') || meta.intent === 'browse' || meta.intent.includes('search');
}

export function getIntentAction(meta: StarBotMeta): string {
  const parts = meta.intent.split('/');
  return parts[1] || 'unknown';
}

export function getIntentCategory(meta: StarBotMeta): string {
  const parts = meta.intent.split('/');
  return parts[0] || 'unknown';
}
