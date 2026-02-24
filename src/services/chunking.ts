/**
 * Chunking Service
 * Splits markdown content into semantic chunks for embedding
 */

export interface Chunk {
  text: string;
  heading?: string;
  tokens: number;
}

/**
 * Simple token estimator (approximation: 1 token ≈ 4 characters)
 * For production, use tiktoken library
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitOversizedText(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  if (text.length <= maxChars) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts.filter(Boolean);
}

/**
 * Splits markdown content by headings into semantic chunks
 * Max 800 tokens per chunk to fit in embedding context
 */
export function chunkMarkdown(content: string, maxTokens = 800): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split('\n');

  let currentChunk: string[] = [];
  let currentHeading: string | undefined;
  let currentTokens = 0;

  const flushChunk = () => {
    if (currentChunk.length > 0) {
      const text = currentChunk.join('\n').trim();
      if (text.length > 0) {
        chunks.push({
          text,
          heading: currentHeading,
          tokens: estimateTokens(text),
        });
      }
      currentChunk = [];
      currentTokens = 0;
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Found a heading - flush current chunk if it exists
      flushChunk();
      currentHeading = headingMatch[2];
      currentChunk.push(line);
      currentTokens = estimateTokens(line);
    } else {
      // Regular line
      const lineTokens = estimateTokens(line);

      // A single oversized line must be split to respect max token bounds.
      if (lineTokens > maxTokens) {
        flushChunk();
        const parts = splitOversizedText(line, maxTokens);
        for (const part of parts) {
          chunks.push({
            text: part,
            heading: currentHeading,
            tokens: estimateTokens(part),
          });
        }
        continue;
      }

      // Check if adding this line would exceed max tokens
      if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
        flushChunk();
      }

      currentChunk.push(line);
      currentTokens += lineTokens;
    }
  }

  // Flush remaining chunk
  flushChunk();

  return chunks;
}

/**
 * Splits very large chunks that exceed max tokens
 * Used as a fallback when heading-based splitting isn't enough
 */
export function splitLargeChunk(text: string, maxTokens = 800): string[] {
  const tokens = estimateTokens(text);

  if (tokens <= maxTokens) {
    return [text];
  }

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);

  let currentChunk = '';
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    if (currentTokens + sentenceTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
      currentTokens = sentenceTokens;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
      currentTokens += sentenceTokens;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  if (chunks.length === 0 || chunks.some(chunk => estimateTokens(chunk) > maxTokens)) {
    return splitOversizedText(text, maxTokens);
  }

  return chunks;
}

/**
 * Process markdown content into chunks ready for embedding
 * Handles both heading-based splitting and large chunk fallback
 */
export function processContent(content: string, maxTokens = 800): Chunk[] {
  const headingChunks = chunkMarkdown(content, maxTokens);
  const finalChunks: Chunk[] = [];

  for (const chunk of headingChunks) {
    if (chunk.tokens > maxTokens) {
      // Split large chunk into smaller pieces
      const pieces = splitLargeChunk(chunk.text, maxTokens);
      for (const piece of pieces) {
        finalChunks.push({
          text: piece,
          heading: chunk.heading,
          tokens: estimateTokens(piece),
        });
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks;
}
