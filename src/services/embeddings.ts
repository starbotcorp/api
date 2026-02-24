/**
 * Embedding Service
 * Generates embeddings using OpenAI text-embedding-3-large
 */

import OpenAI from 'openai';

let openaiClient: OpenAI | null = null;

/**
 * Initialize OpenAI client
 * Only creates client if OPENAI_API_KEY is available
 */
function getOpenAIClient(): OpenAI | null {
  if (openaiClient) {
    return openaiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set - embeddings will not be generated');
    return null;
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

/**
 * Generate embedding for a single text chunk
 * Uses text-embedding-3-large (3072 dimensions)
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const client = getOpenAIClient();
  if (!client) {
    return null;
  }

  try {
    const response = await client.embeddings.create({
      model: 'text-embedding-3-large',
      input: text,
      encoding_format: 'float',
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * OpenAI supports up to 2048 inputs per request
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize = 100
): Promise<(number[] | null)[]> {
  const client = getOpenAIClient();
  if (!client) {
    return texts.map(() => null);
  }

  const embeddings: (number[] | null)[] = [];

  // Process in batches to avoid rate limits
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    try {
      const response = await client.embeddings.create({
        model: 'text-embedding-3-large',
        input: batch,
        encoding_format: 'float',
      });

      embeddings.push(...response.data.map((d) => d.embedding));
    } catch (error) {
      console.error(`Error generating embeddings for batch ${i}-${i + batchSize}:`, error);
      // Add nulls for failed batch
      embeddings.push(...batch.map(() => null));
    }

    // Small delay to avoid rate limits
    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return embeddings;
}

/**
 * Check if embeddings are available (API key is set)
 */
export function areEmbeddingsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
