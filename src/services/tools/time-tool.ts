// Current Time Tool
// Returns the current date and time

import type { ToolDefinition, ToolResult } from './types.js';
import { env } from '../../env.js';

export const timeTool: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current date and time. Use this when users ask "what time is it", "what\'s the date", or any time-related questions.',
  parameters: [
    {
      name: 'format',
      type: 'string',
      description: 'Optional format: "full" (default), "short", "time_only", "date_only", "iso"',
      required: false,
    },
  ],
  execute: async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      const format = String(args.format || 'full');
      const now = new Date();

      // Use default timezone from env or UTC
      const defaultTimezone = env.DEFAULT_TIMEZONE || 'UTC';

      // Format the time based on requested format
      let result: any = {
        timestamp_utc: now.toISOString(),
        default_timezone: defaultTimezone,
      };

      switch (format) {
        case 'iso':
          result.formatted = now.toISOString();
          break;

        case 'time_only':
          result.formatted = now.toLocaleTimeString('en-US', { timeZone: defaultTimezone, hour12: false });
          result.formatted_12h = now.toLocaleTimeString('en-US', { timeZone: defaultTimezone, hour12: true });
          result.utc_time = now.toISOString().split('T')[1].split('.')[0];
          break;

        case 'date_only':
          result.formatted = now.toLocaleDateString('en-US', { timeZone: defaultTimezone });
          result.utc_date = now.toISOString().split('T')[0];
          break;

        case 'short':
          result.formatted = now.toLocaleString('en-US', { timeZone: defaultTimezone });
          break;

        case 'full':
        default:
          result.formatted = now.toLocaleString('en-US', {
            timeZone: defaultTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          result.day_of_week = now.toLocaleDateString('en-US', { timeZone: defaultTimezone, weekday: 'long' });
          result.hour_24 = now.toLocaleTimeString('en-US', { timeZone: defaultTimezone, hour12: false });
          result.utc = now.toISOString();
          break;
      }

      return {
        success: true,
        content: JSON.stringify(result),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to get current time: ${errorMessage}` }),
      };
    }
  },
};
