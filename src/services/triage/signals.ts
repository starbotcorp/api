// Stage A: Signal Detection
// Detect patterns in user messages without external calls

import type { TriageInput, TriageSignals } from './types.js';

// Regex patterns for detection
const CODE_BLOCK_REGEX = /```(?:[\w.+-]+)?\n?([\s\S]*?)```/g;
const STACK_TRACE_REGEX = /(^\s*at\s+\S+|Traceback\s*\(most recent call last\)|Exception:|Error:|panic:|FATAL|Caused by:|\bTS\d{3,5}\b|\bERR_[A-Z_]+\b)/m;
const COMMAND_LINE_REGEX = /^\s*(\$|>|PS>|sudo\b)/im;

const IMPLEMENT_REQUEST_REGEX = /\b(implement|refactor|add feature|add endpoint|build|create|code this|change this code|update this code|write code)\b/i;
const EXPLANATION_REQUEST_REGEX = /\b(explain|what does|how does|walk me through|clarify|why does|describe)\b/i;
const SUMMARY_REQUEST_REGEX = /\b(summarize|summary|tldr|tl;dr|overview|recap|key points|gist)\b/i;
const REWRITE_REQUEST_REGEX = /\b(rewrite|rephrase|polish|edit this|improve wording|tighten|reformat)\b/i;
const EXTRACTION_REQUEST_REGEX = /\b(extract|parse|structured|json|table|checklist|schema|convert to)\b/i;
const COMPARE_REQUEST_REGEX = /\b(compare|versus|vs\.?|difference|tradeoff|trade-off|pros and cons|recommend|which is better)\b/i;
const PLAN_REQUEST_REGEX = /\b(plan|design|architecture|architect|roadmap|approach|spec|outline)\b/i;
const DEBUG_REQUEST_REGEX = /\b(debug|bug|broken|not working|fix error|fails?|crash|error)\b/i;
const BRAINSTORM_REQUEST_REGEX = /\b(brainstorm|ideas|options|alternatives|possibilities|suggestions)\b/i;
const QUICK_REQUEST_REGEX = /\b(quick|brief|short|concise|simple)\b/i;
const DEEP_REQUEST_REGEX = /\b(deep|thorough|detailed|in-depth|comprehensive|production-ready|extensive)\b/i;

const LANGUAGE_HINTS: Array<{ language: string; regex: RegExp }> = [
  { language: 'typescript', regex: /(\.tsx?\b|```\s*ts\b|```\s*typescript\b|\binterface\s+\w+)/i },
  { language: 'javascript', regex: /(\.jsx?\b|```\s*js\b|```\s*javascript\b|\bmodule\.exports\b)/i },
  { language: 'python', regex: /(\.py\b|```\s*py\b|```\s*python\b|\bdef\s+\w+\()/i },
  { language: 'go', regex: /(\.go\b|```\s*go\b|\bpackage\s+main\b)/i },
  { language: 'rust', regex: /(\.rs\b|```\s*rust\b|\bfn\s+main\s*\()/i },
  { language: 'java', regex: /(\.java\b|```\s*java\b|\bpublic\s+class\b)/i },
  { language: 'c', regex: /(\.c\b|```\s*c\b|\b#include\s*<)/i },
  { language: 'cpp', regex: /(\.c(pp|xx)?\b|\.h(pp)?\b|```\s*c\+\+\b)/i },
  { language: 'php', regex: /(\.php\b|```\s*php\b|<\?php)/i },
  { language: 'ruby', regex: /(\.rb\b|```\s*ruby\b|\bclass\s+\w+\s*<\s*\w+)/i },
  { language: 'shell', regex: /(\.sh\b|```\s*bash\b|```\s*shell\b|\bsudo\s+\w+)/i },
  { language: 'sql', regex: /(\.sql\b|```\s*sql\b|\bselect\s+.+\s+from\b)/i },
  { language: 'html', regex: /(\.html?\b|```\s*html\b|<html|<div)/i },
  { language: 'css', regex: /(\.css\b|```\s*css\b|\{\s*color\s*:)/i },
  { language: 'json', regex: /(\.json\b|```\s*json\b|"\w+"\s*:\s*\{?)/i },
  { language: 'yaml', regex: /(\.ya?ml\b|```\s*ya?ml\b|\w+:\s*\w+)/i },
];

function extractCodeSegments(message: string): string[] {
  const segments: string[] = [];
  let match: RegExpExecArray | null;

  const regex = new RegExp(CODE_BLOCK_REGEX);
  while ((match = regex.exec(message)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
    }
  }

  return segments;
}

function detectLanguages(input: TriageInput, codeSegments: string[]): string[] {
  const haystack = [
    input.user_message,
    ...codeSegments,
    ...((input.attachments || []).map(a => a.filename || '')),
  ].join('\n');

  const languages = new Set<string>();

  for (const hint of LANGUAGE_HINTS) {
    if (hint.regex.test(haystack)) {
      languages.add(hint.language);
    }
  }

  return Array.from(languages);
}

export function detectSignals(input: TriageInput): TriageSignals {
  const message = input.user_message;
  const codeSegments = extractCodeSegments(message);
  const detectedLanguages = detectLanguages(input, codeSegments);

  const hasImage = (input.attachments || []).some(a => a.type === 'image');
  const hasFileAttachment = (input.attachments || []).some(a => a.type === 'file' || a.type === 'text');

  // Estimate tokens (rough: 1 token ≈ 4 characters)
  const estimatedInputTokens = Math.ceil(message.length / 4);
  const estimatedContextTokens = input.context_summary ? Math.ceil(input.context_summary.length / 4) : 0;

  // Compute complexity score (1-5)
  let complexityScore = 1;
  if (codeSegments.length > 0) complexityScore++;
  if (estimatedInputTokens > 2000) complexityScore++; // Long input
  if (detectedLanguages.length > 1) complexityScore++; // Multi-language
  if (DEEP_REQUEST_REGEX.test(message)) complexityScore++;
  complexityScore = Math.min(5, complexityScore);

  return {
    // Attachments
    has_image_attachment: hasImage,
    has_file_attachment: hasFileAttachment,
    has_code_block: codeSegments.length > 0,
    has_stack_trace: STACK_TRACE_REGEX.test(message),
    has_command_snippet: COMMAND_LINE_REGEX.test(message),

    // Intent signals
    asks_for_implementation: IMPLEMENT_REQUEST_REGEX.test(message),
    asks_for_explanation: EXPLANATION_REQUEST_REGEX.test(message),
    asks_for_summary: SUMMARY_REQUEST_REGEX.test(message),
    asks_for_rewrite: REWRITE_REQUEST_REGEX.test(message),
    asks_for_extraction: EXTRACTION_REQUEST_REGEX.test(message),
    asks_for_comparison: COMPARE_REQUEST_REGEX.test(message),
    asks_for_plan: PLAN_REQUEST_REGEX.test(message),
    asks_for_debug: DEBUG_REQUEST_REGEX.test(message),
    asks_for_brainstorm: BRAINSTORM_REQUEST_REGEX.test(message),
    asks_for_quick: QUICK_REQUEST_REGEX.test(message),
    asks_for_deep: DEEP_REQUEST_REGEX.test(message),

    // Complexity signals
    long_input: estimatedInputTokens > 2000,
    short_input: estimatedInputTokens < 100,
    detected_languages: detectedLanguages,
    complexity_score: complexityScore,

    // Metadata
    estimated_input_tokens: estimatedInputTokens,
    estimated_context_tokens: estimatedContextTokens,
  };
}
