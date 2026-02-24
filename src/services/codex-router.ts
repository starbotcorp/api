// Codex Header Routing Protocol
// Every prompt passes through GPT-5.1 Codex Mini first, which stamps it with a structured
// header for downstream model routing. Replaces interpreter + triage when enabled.

import { env } from '../env.js';
import { getProvider } from '../providers/index.js';
import type { InterpreterIntent } from './interpreter.js';

export interface CodexHeader {
  intent: InterpreterIntent;
  category: string;
  complexity: number;
  lane: 'quick' | 'standard' | 'deep';
  tier: number;
  tools: string[];
  contextNeeds: string[];
  confidence: number;
  reasoning: string;
  safety: string;
}

const HEADER_START = '<<<STARBOT_HEADER';
const HEADER_END = '>>>';

const CODEX_SYSTEM_PROMPT = `You are the Starbot routing layer. Analyze the user message and return ONLY a structured header block — nothing else.

FORMAT (return exactly this structure):
<<<STARBOT_HEADER
intent: <chat|browse|filesystem|code|shell|tool|clarify>
category: <CHAT_QA|CODE_CHANGE|DEBUG|CODE_EXPLAIN|BRAINSTORM|WRITE_REWRITE|SUMMARIZE|EXTRACT_STRUCTURE|RESEARCH_COMPARE|PLAN_DESIGN|CLI_OPS|META_TRACE>
complexity: <1-5>
lane: <quick|standard|deep>
tier: <1|2|3>
tools: [<comma-separated tool names or empty>]
context_needs: [<comma-separated: workspace_memory, project_memory, identity, web_search, tasks>]
confidence: <0.0-1.0>
reasoning: <one line explanation>
safety: <safety notes or "none">
>>>

RULES:
- intent=clarify: user message is ambiguous or empty, needs clarification before routing
- intent=browse: user wants web search / current info / research
- intent=filesystem: user wants file operations (read, write, edit, glob, grep, list)
- intent=code: user wants code generation, debugging, refactoring
- intent=shell: user wants to run terminal commands (build, test, install, git)
- intent=tool: user wants a specific tool action
- intent=chat: general conversation, Q&A, explanations (default)

CATEGORY MAPPING:
- CHAT_QA: general questions, explanations
- CODE_CHANGE: writing or modifying code
- DEBUG: fixing bugs, troubleshooting
- CODE_EXPLAIN: explaining existing code
- BRAINSTORM: ideation, creative thinking
- WRITE_REWRITE: prose writing, rewriting text
- SUMMARIZE: condensing content
- EXTRACT_STRUCTURE: parsing, structuring data
- RESEARCH_COMPARE: comparing options, research
- PLAN_DESIGN: architecture, system design
- CLI_OPS: terminal/shell operations
- META_TRACE: meta questions about the assistant itself

TIER LOGIC:
- tier 1: simple Q&A, quick lookups, trivial tasks (lane=quick)
- tier 2: standard coding, moderate complexity (lane=standard)
- tier 3: deep reasoning, architecture, multi-file changes (lane=deep)

AVAILABLE TOOLS:
- web_search: search the web
- calculator: math evaluation
- code_exec: execute code snippets
- file_read: read file contents
- fs_write_file: write/create files
- fs_edit_file: search-and-replace in files
- fs_glob: find files by pattern
- fs_grep: search content in files
- shell_exec: run shell commands
- fs_advanced_ops: advanced file operations (copy, move, delete, etc.)

Only include tools the user's request actually needs. Most chat/QA requests need no tools.

CONTEXT_NEEDS:
- workspace_memory: inject workspace-specific memory (for code/file tasks within a workspace)
- project_memory: inject project-wide memory
- identity: inject identity/personality context
- web_search: pre-fetch web results for context
- tasks: inject task list context

Return ONLY the header block. No explanation, no extra text.`;

export function serializeHeader(header: CodexHeader): string {
  return [
    HEADER_START,
    `intent: ${header.intent}`,
    `category: ${header.category}`,
    `complexity: ${header.complexity}`,
    `lane: ${header.lane}`,
    `tier: ${header.tier}`,
    `tools: [${header.tools.join(', ')}]`,
    `context_needs: [${header.contextNeeds.join(', ')}]`,
    `confidence: ${header.confidence}`,
    `reasoning: ${header.reasoning}`,
    `safety: ${header.safety}`,
    HEADER_END,
  ].join('\n');
}

export function parseHeader(raw: string): CodexHeader | null {
  const startIdx = raw.indexOf(HEADER_START);
  const endIdx = raw.indexOf(HEADER_END, startIdx + HEADER_START.length);
  if (startIdx === -1 || endIdx === -1) return null;

  const block = raw.slice(startIdx + HEADER_START.length, endIdx).trim();
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

  const fields: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  const parseArray = (val: string | undefined): string[] => {
    if (!val) return [];
    const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim()).filter(Boolean);
  };

  const intent = normalizeHeaderIntent(fields['intent']);
  const lane = normalizeLane(fields['lane']);
  const tier = clampInt(fields['tier'], 1, 3, 2);
  const complexity = clampInt(fields['complexity'], 1, 5, 3);
  const confidence = clampFloat(fields['confidence'], 0, 1, 0.5);

  return {
    intent,
    category: fields['category'] || 'CHAT_QA',
    complexity,
    lane,
    tier,
    tools: parseArray(fields['tools']),
    contextNeeds: parseArray(fields['context_needs']),
    confidence,
    reasoning: fields['reasoning'] || '',
    safety: fields['safety'] || 'none',
  };
}

export function stripHeader(content: string): string {
  // Remove all <<<STARBOT_HEADER ... >>> blocks from content
  const regex = /<<<STARBOT_HEADER[\s\S]*?>>>/g;
  return content.replace(regex, '').trim();
}

export async function classifyWithCodex(
  userMessage: string,
  conversationContext?: string,
): Promise<CodexHeader> {
  const trimmed = (userMessage || '').trim();

  // Handle empty message
  if (!trimmed) {
    return {
      intent: 'clarify',
      category: 'CHAT_QA',
      complexity: 1,
      lane: 'quick',
      tier: 1,
      tools: [],
      contextNeeds: [],
      confidence: 1.0,
      reasoning: 'Empty message requires clarification',
      safety: 'none',
    };
  }

  try {
    const provider = getProvider('azure');

    const messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }> = [
      { role: 'system', content: CODEX_SYSTEM_PROMPT },
    ];

    // Include conversation context if provided (e.g. recent messages summary)
    if (conversationContext) {
      messages.push({
        role: 'system',
        content: `Recent conversation context:\n${conversationContext}`,
      });
    }

    messages.push({
      role: 'user',
      content: trimmed,
    });

    const response = await provider.sendChat(messages, {
      model: env.CODEX_ROUTER_MODEL,
      maxTokens: env.CODEX_ROUTER_MAX_TOKENS,
      temperature: 0.1,
    });

    const header = parseHeader(response.content);
    if (!header) {
      throw new Error('Codex response did not contain a valid header block');
    }

    return header;
  } catch (error) {
    // Fallback: return null to signal caller should use legacy pipeline
    throw error;
  }
}

// --- Internal helpers ---

function normalizeHeaderIntent(raw: string | undefined): InterpreterIntent {
  const val = (raw || '').trim().toLowerCase();
  const valid: InterpreterIntent[] = ['chat', 'browse', 'filesystem', 'code', 'shell', 'tool', 'clarify'];
  return (valid.includes(val as InterpreterIntent) ? val : 'chat') as InterpreterIntent;
}

function normalizeLane(raw: string | undefined): 'quick' | 'standard' | 'deep' {
  const val = (raw || '').trim().toLowerCase();
  if (val === 'quick' || val === 'standard' || val === 'deep') return val;
  return 'standard';
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const num = parseInt(raw || '', 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function clampFloat(raw: string | undefined, min: number, max: number, fallback: number): number {
  const num = parseFloat(raw || '');
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}
