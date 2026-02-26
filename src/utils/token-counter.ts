// Token counting utility for context management
// Fix #8: Unbounded Context Growth

// Approximate token counting based on character count
// This is a rough estimate - for production, use tiktoken or provider-specific tokenizers
// Rule of thumb: ~4 characters per token for English text

const CHARS_PER_TOKEN = 4;

/**
 * Count approximate tokens in a string
 * This is a simple heuristic - for accurate counting, use tiktoken
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  // Basic heuristic: 4 characters per token
  const baseTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  // Adjust for whitespace (tokens often break on whitespace)
  const whitespaceBoost = (text.match(/\s+/g) || []).length * 0.1;

  // Adjust for special characters and punctuation
  const specialCharBoost = (text.match(/[^\w\s]/g) || []).length * 0.05;

  return Math.ceil(baseTokens + whitespaceBoost + specialCharBoost);
}

/**
 * Count tokens in an array of messages
 */
export function countMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;

  for (const msg of messages) {
    // Add overhead for message structure (role, formatting)
    total += 4; // Approximate overhead per message
    total += countTokens(msg.content);
  }

  return total;
}

const MAX_CONTEXT_TOKENS = 32000; // Leave room for response

interface ContextMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

/**
 * Build context messages within token limits
 * Prioritizes system prompts first, then newest messages
 */
export function buildContextMessages(
  systemPrompts: string[],
  messages: ContextMessage[],
  maxTokens: number = MAX_CONTEXT_TOKENS
): { messages: ContextMessage[]; tokenCount: number; truncated: boolean } {
  const result: ContextMessage[] = [];
  let tokenCount = 0;
  let truncated = false;

  // Add system prompts first (highest priority)
  for (const prompt of systemPrompts) {
    const tokens = countTokens(prompt) + 4; // +4 for message overhead
    if (tokenCount + tokens <= maxTokens) {
      result.push({ role: 'system', content: prompt });
      tokenCount += tokens;
    } else {
      truncated = true;
      break;
    }
  }

  // Add conversation messages, newest first, then reverse
  const sortedMessages = [...messages].reverse();
  const contextMessages: ContextMessage[] = [];

  for (const msg of sortedMessages) {
    const tokens = countTokens(msg.content) + 4; // +4 for message overhead
    if (tokenCount + tokens <= maxTokens) {
      contextMessages.unshift(msg);
      tokenCount += tokens;
    } else {
      truncated = true;
      break;
    }
  }

  return {
    messages: [...result, ...contextMessages],
    tokenCount,
    truncated,
  };
}

/**
 * Check if adding more content would exceed the limit
 */
export function wouldExceedLimit(
  currentTokens: number,
  additionalContent: string,
  maxTokens: number = MAX_CONTEXT_TOKENS
): boolean {
  return currentTokens + countTokens(additionalContent) > maxTokens;
}

export { MAX_CONTEXT_TOKENS };
