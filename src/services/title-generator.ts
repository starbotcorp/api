// Title Generator Service
// Generates short chat titles using DeepSeek

import { getProvider } from '../providers/index.js';
import { prisma } from '../db.js';

const TITLE_PROMPT = `Generate a very short title (3-6 words max) for a chat that starts with this message.

Rules:
- Maximum 6 words
- No quotes, no punctuation at the end
- Be descriptive but concise
- Focus on the main topic or intent

Message: `;

/**
 * Generate a short title for a chat using DeepSeek
 */
export async function generateChatTitle(userMessage: string): Promise<string> {
  try {
    // Use DeepSeek Chat (fast and cheap)
    const provider = getProvider('deepseek');
    const modelName = 'deepseek-chat';

    let title = '';

    const messages = [
      { role: 'system' as const, content: 'You are a title generator. Respond with ONLY the title, nothing else. Maximum 6 words.' },
      { role: 'user' as const, content: TITLE_PROMPT + userMessage.slice(0, 500) },
    ];

    for await (const chunk of provider.sendChatStream(messages, {
      model: modelName,
      maxTokens: 50,
      temperature: 0.3,
    })) {
      if (chunk.text) {
        title += chunk.text;
      }
    }

    // Clean up the title
    title = title
      .replace(/^["']|["']$/g, '')  // Remove surrounding quotes
      .replace(/\n.*/g, '')          // Only keep first line
      .replace(/[.!?:]$/, '')        // Remove trailing punctuation
      .trim();

    // Enforce max length (6 words)
    const words = title.split(/\s+/);
    if (words.length > 6) {
      title = words.slice(0, 6).join(' ');
    }

    return title || 'New Chat';
  } catch (error) {
    console.error('[Title Generator] Generation failed:', error);
    return '';
  }
}

/**
 * Generate and update chat title in the background
 * Does not block the main response
 */
export function generateAndUpdateTitle(
  chatId: string,
  userMessage: string,
  onTitleUpdated?: (chatId: string, newTitle: string) => void
): void {
  // Run in background - don't await
  (async () => {
    try {
      const title = await generateChatTitle(userMessage);

      if (title && title !== 'New Chat') {
        await prisma.chat.update({
          where: { id: chatId },
          data: { title },
        });

        // Callback if provided
        if (onTitleUpdated) {
          onTitleUpdated(chatId, title);
        }

        console.log(`[Title Generator] Updated chat ${chatId} title to: "${title}"`);
      }
    } catch (error) {
      console.error('[Title Generator] Failed to update title:', error);
    }
  })().catch(err => {
    console.error('[Title Generator] Unhandled error:', err);
  });
}
