// Calendar Tools - Manage user calendar events
import type { ToolDefinition, ToolResult, ToolContext } from './types.js';
import { prisma } from '../../db.js';

// Helper to get user ID from request
function getUserId(context?: ToolContext): string | null {
  return (context as any)?.userId || null;
}

export const addCalendarEventTool: ToolDefinition = {
  name: 'add_calendar_event',
  description: 'Create a new calendar event. Use this when users ask to schedule something, set a reminder, or add something to their calendar.',
  parameters: [
    {
      name: 'title',
      type: 'string',
      description: 'Event title (e.g., "Team meeting", "Dentist appointment", "Project deadline")',
      required: true,
    },
    {
      name: 'startTime',
      type: 'string',
      description: 'Start time in ISO 8601 format (e.g., "2026-03-01T14:00:00Z")',
      required: true,
    },
    {
      name: 'description',
      type: 'string',
      description: 'Event description or notes',
      required: false,
    },
    {
      name: 'location',
      type: 'string',
      description: 'Event location',
      required: false,
    },
  ],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      const userId = getUserId(context);
      if (!userId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'User context not available' }),
        };
      }

      const title = String(args.title);
      let startTime: Date;

      // Try to parse ISO date or relative time
      if (args.startTime.includes('T')) {
        startTime = new Date(args.startTime);
      } else {
        // Simple relative time parsing
        const now = new Date();
        const input = args.startTime.toLowerCase();

        if (input.includes('tomorrow')) {
          startTime = new Date(now);
          startTime.setDate(startTime.getDate() + 1);
          startTime.setHours(9, 0, 0, 0);
        } else if (input.includes('next monday')) {
          startTime = new Date(now);
          const daysUntilMonday = (7 - startTime.getDay() + 1) % 7 || 7;
          startTime.setDate(startTime.getDate() + daysUntilMonday);
          startTime.setHours(9, 0, 0, 0);
        } else if (input.includes('next week')) {
          startTime = new Date(now);
          startTime.setDate(startTime.getDate() + 7);
          startTime.setHours(9, 0, 0, 0);
        } else {
          startTime = now;
          startTime.setHours(now.getHours() + 1, 0, 0, 0);
        }

        if (isNaN(startTime.getTime())) {
          startTime = now;
        }
      }

      const userTimezone = context?.userTimezone || 'UTC';

      const event = await prisma.calendar.create({
        data: {
          userId,
          title,
          description: args.description ? String(args.description) : null,
          startTime,
          timezone: userTimezone,
          location: args.location ? String(args.location) : null,
        },
      });

      return {
        success: true,
        content: JSON.stringify({
          message: `Added "${title}" to calendar on ${startTime.toLocaleString('en-US', { timeZone: userTimezone })}`,
          event: {
            id: event.id,
            title: event.title,
            startTime: event.startTime.toISOString(),
            timezone: event.timezone,
          },
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to add calendar event: ${error instanceof Error ? error.message : String(error)}` }),
      };
    }
  },
};

export const listCalendarEventsTool: ToolDefinition = {
  name: 'list_calendar_events',
  description: 'List calendar events for a date range. Use this when users ask about their schedule, upcoming events, or what they have planned.',
  parameters: [
    {
      name: 'startDate',
      type: 'string',
      description: 'Start date in ISO 8601 format (e.g., "2026-03-01")',
      required: false,
    },
    {
      name: 'endDate',
      type: 'string',
      description: 'End date in ISO 8601 format',
      required: false,
    },
    {
      name: 'status',
      type: 'string',
      description: 'Filter by status: "scheduled", "completed", "cancelled"',
      required: false,
    },
  ],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      const userId = getUserId(context);
      if (!userId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'User context not available' }),
        };
      }

      const where: any = { userId };

      if (args.startDate || args.endDate) {
        where.startTime = {};
        if (args.startDate) {
          where.startTime.gte = new Date(args.startDate);
        }
        if (args.endDate) {
          where.startTime.lte = new Date(args.endDate);
        }
      }

      if (args.status && ['scheduled', 'completed', 'cancelled'].includes(args.status)) {
        where.status = args.status;
      }

      const events = await prisma.calendar.findMany({
        where,
        orderBy: { startTime: 'asc' },
        take: 50,
      });

      const userTimezone = context?.userTimezone || 'UTC';
      const formattedEvents = events.map(event => ({
        id: event.id,
        title: event.title,
        description: event.description,
        startTime: event.startTime.toISOString(),
        startTimeLocal: event.startTime.toLocaleString('en-US', { timeZone: userTimezone }),
        endTime: event.endTime?.toISOString(),
        endTimeLocal: event.endTime?.toLocaleString('en-US', { timeZone: userTimezone }),
        timezone: event.timezone,
        status: event.status,
        location: event.location,
      }));

      return {
        success: true,
        content: JSON.stringify({
          count: events.length,
          events: formattedEvents,
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to list calendar events: ${error instanceof Error ? error.message : String(error)}` }),
      };
    }
  },
};

export const getUpcomingEventsTool: ToolDefinition = {
  name: 'get_upcoming_events',
  description: 'Get upcoming calendar events. Use this when users ask what they have coming up, what is on their schedule, or what is happening soon.',
  parameters: [
    {
      name: 'days',
      type: 'number',
      description: 'Number of days ahead to look (default: 7)',
      required: false,
    },
  ],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      const userId = getUserId(context);
      if (!userId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'User context not available' }),
        };
      }

      const days = typeof args.days === 'number' ? args.days : 7;
      const now = new Date();
      const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const events = await prisma.calendar.findMany({
        where: {
          userId,
          status: 'scheduled',
          startTime: { gte: now, lte: future },
        },
        orderBy: { startTime: 'asc' },
        take: 20,
      });

      const userTimezone = context?.userTimezone || 'UTC';
      const formattedEvents = events.map(event => ({
        id: event.id,
        title: event.title,
        description: event.description,
        startTime: event.startTime.toISOString(),
        startTimeLocal: event.startTime.toLocaleString('en-US', {
          timeZone: userTimezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
        endTime: event.endTime?.toISOString(),
        endTimeLocal: event.endTime?.toLocaleString('en-US', {
          timeZone: userTimezone,
          hour: 'numeric',
          minute: '2-digit',
        }),
        location: event.location,
        daysUntil: Math.ceil((event.startTime.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
      }));

      return {
        success: true,
        content: JSON.stringify({
          count: events.length,
          days: days,
          timezone: userTimezone,
          events: formattedEvents,
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to get upcoming events: ${error instanceof Error ? error.message : String(error)}` }),
      };
    }
  },
};

export const updateCalendarEventTool: ToolDefinition = {
  name: 'update_calendar_event',
  description: 'Update an existing calendar event. Use this when users ask to change, reschedule, or modify a calendar entry.',
  parameters: [
    {
      name: 'eventId',
      type: 'string',
      description: 'Event ID to update',
      required: true,
    },
    {
      name: 'status',
      type: 'string',
      description: 'New status: "scheduled", "completed", "cancelled"',
      required: false,
    },
  ],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      const userId = getUserId(context);
      if (!userId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'User context not available' }),
        };
      }

      const event = await prisma.calendar.findFirst({
        where: { id: String(args.eventId), userId },
      });

      if (!event) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Event not found or access denied' }),
        };
      }

      const updateData: any = {};

      if (args.status && ['scheduled', 'completed', 'cancelled'].includes(args.status)) {
        updateData.status = args.status;
      }

      const updated = await prisma.calendar.update({
        where: { id: String(args.eventId) },
        data: updateData,
      });

      return {
        success: true,
        content: JSON.stringify({
          message: `Updated calendar event "${updated.title}"`,
          event: {
            id: updated.id,
            title: updated.title,
            startTime: updated.startTime.toISOString(),
            status: updated.status,
          },
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to update calendar event: ${error instanceof Error ? error.message : String(error)}` }),
      };
    }
  },
};

export const deleteCalendarEventTool: ToolDefinition = {
  name: 'delete_calendar_event',
  description: 'Delete a calendar event. Use this when users ask to remove or cancel a calendar entry.',
  parameters: [
    {
      name: 'eventId',
      type: 'string',
      description: 'Event ID to delete',
      required: true,
    },
  ],
  execute: async (args: Record<string, any>, context?: ToolContext): Promise<ToolResult> => {
    try {
      const userId = getUserId(context);
      if (!userId) {
        return {
          success: false,
          content: JSON.stringify({ error: 'User context not available' }),
        };
      }

      const event = await prisma.calendar.findFirst({
        where: { id: String(args.eventId), userId },
      });

      if (!event) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Event not found or access denied' }),
        };
      }

      await prisma.calendar.delete({
        where: { id: String(args.eventId) },
      });

      return {
        success: true,
        content: JSON.stringify({
          message: `Deleted calendar event "${event.title}"`,
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({ error: `Failed to delete calendar event: ${error instanceof Error ? error.message : String(error)}` }),
      };
    }
  },
};
