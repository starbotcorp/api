// Conversation Metadata Tool
// Returns conversation timing and statistics for temporal awareness

import type { ToolDefinition, ToolResult, ToolContext } from './types.js';

export const conversationMetadataTool: ToolDefinition = {
  name: 'get_conversation_metadata',
  description: 'Get conversation metadata including start time, elapsed time, message count, and timing information. Use this when answering questions about conversation duration, timing, or when something was discussed.',
  parameters: [],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      if (!context?.chatId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'No chat context available' }),
        };
      }

      const now = new Date();
      const chatStarted = new Date(context.chatCreated || now);
      const elapsedMs = now.getTime() - chatStarted.getTime();

      // Calculate elapsed time in readable format
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      const elapsedHours = Math.floor(elapsedMs / 3600000);
      const elapsedDays = Math.floor(elapsedMs / 86400000);

      let elapsedFormatted = '';
      if (elapsedDays > 0) {
        elapsedFormatted = `${elapsedDays} day${elapsedDays > 1 ? 's' : ''}`;
      } else if (elapsedHours > 0) {
        elapsedFormatted = `${elapsedHours} hour${elapsedHours > 1 ? 's' : ''}`;
      } else if (elapsedMinutes > 0) {
        elapsedFormatted = `${elapsedMinutes} minute${elapsedMinutes > 1 ? 's' : ''}`;
      } else if (elapsedSeconds > 0) {
        elapsedFormatted = `${elapsedSeconds} second${elapsedSeconds > 1 ? 's' : ''}`;
      } else {
        elapsedFormatted = 'less than a second';
      }

      const result = {
        conversation_id: context.chatId,
        chat_started_utc: chatStarted.toISOString(),
        current_time_utc: now.toISOString(),
        elapsed_ms: elapsedMs,
        elapsed_seconds: elapsedSeconds,
        elapsed_formatted: elapsedFormatted,
        message_count: context.messageCount || 0,
        user_timezone: context.userTimezone || 'UTC',
        chat_started_user_tz: chatStarted.toLocaleString('en-US', { timeZone: context.userTimezone || 'UTC' }),
        current_time_user_tz: now.toLocaleString('en-US', { timeZone: context.userTimezone || 'UTC' }),
      };

      return {
        success: true,
        content: JSON.stringify(result),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to get conversation metadata: ${errorMessage}` }),
      };
    }
  },
};
