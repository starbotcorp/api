// User Facts Tool
// Allows the AI to save and manage user facts during onboarding and conversations

import type { ToolDefinition, ToolResult } from './types.js';
import { prisma } from '../../db.js';

/**
 * Tool to save user facts during onboarding or conversation
 * This tool should be called when the AI learns new information about the user
 */
export const saveUserFactTool: ToolDefinition = {
  name: 'save_user_fact',
  description: 'Save a fact about the user. Use this when you learn new information about the user (name, timezone, role, preferences, etc.). During onboarding, facts are saved as PENDING and promoted to ACTIVE on completion. Otherwise facts are saved as ACTIVE immediately.',
  parameters: [
    {
      name: 'fact_key',
      type: 'string',
      description: 'The key/label for the fact (e.g., "name", "timezone", "role", "favorite_color")',
      required: true,
    },
    {
      name: 'fact_value',
      type: 'string',
      description: 'The value of the fact (string, or JSON-serializable data)',
      required: true,
    },
    {
      name: 'confidence',
      type: 'number',
      description: 'Confidence score from 0.0 to 1.0 (default 1.0). Use lower values for inferred or uncertain facts.',
      required: false,
      default: 1.0,
    },
    {
      name: 'source',
      type: 'string',
      description: 'Where this fact came from (e.g., "onboarding", "conversation", "manual")',
      required: false,
      default: 'conversation',
    },
  ],
  execute: async (args, context): Promise<ToolResult> => {
    const { fact_key, fact_value, source = 'conversation' } = args;
    const confidence = typeof args.confidence === 'number' ? Math.max(0, Math.min(1, args.confidence)) : 1.0;

    const userId = (context?.request as any)?.userId;

    if (!userId) {
      return {
        success: false,
        content: JSON.stringify({ error: 'User not authenticated' }),
      };
    }

    try {
      // Check onboarding status to determine PENDING vs ACTIVE
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { onboardingStatus: true },
      });

      const status = user?.onboardingStatus === 'IN_PROGRESS' ? 'PENDING' : 'ACTIVE';

      const fact = await prisma.userFact.upsert({
        where: {
          userId_factKey: {
            userId,
            factKey: fact_key,
          },
        },
        create: {
          userId,
          factKey: fact_key,
          factValue: fact_value,
          source,
          confidence,
          status,
        },
        update: {
          factValue: fact_value,
          source,
          confidence,
          status,
          updatedAt: new Date(),
        },
      });

      return {
        success: true,
        content: JSON.stringify({
          message: `Saved fact: ${fact_key} = ${fact_value}`,
          fact: {
            key: fact.factKey,
            value: fact.factValue,
            source: fact.source,
            confidence: fact.confidence,
            status: fact.status,
          },
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Failed to save fact',
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};

/**
 * Tool to complete onboarding after collecting user facts
 * This sets the user's onboarding status to COMPLETED
 */
export const completeOnboardingTool: ToolDefinition = {
  name: 'complete_onboarding',
  description: 'Mark onboarding as complete. Call this after you have collected the essential user information (name, timezone, role). This will activate the user\'s facts for future conversations.',
  parameters: [
    {
      name: 'facts',
      type: 'object',
      description: 'Object containing the collected facts (e.g., {"name": "Alex", "timezone": "America/New_York", "role": "developer"})',
      required: true,
    },
  ],
  execute: async (args, context): Promise<ToolResult> => {
    const { facts } = args;
    const userId = (context?.request as any)?.userId;

    if (!userId) {
      return {
        success: false,
        content: JSON.stringify({ error: 'User not authenticated' }),
      };
    }

    try {
      // Validate required facts
      const requiredKeys = ['name', 'timezone', 'role'];
      const providedKeys = Object.keys(facts);
      const missingKeys = requiredKeys.filter(k => !providedKeys.includes(k));

      if (missingKeys.length > 0) {
        return {
          success: false,
          content: JSON.stringify({
            error: 'Missing required facts',
            missing: missingKeys,
            message: `Please collect the following information: ${missingKeys.join(', ')}`,
          }),
        };
      }

      // Use transaction to save all facts and update status
      await prisma.$transaction(async (tx) => {
        // Save each fact
        for (const [factKey, factValue] of Object.entries(facts)) {
          const valueStr = typeof factValue === 'string' ? factValue : JSON.stringify(factValue);

          await tx.userFact.upsert({
            where: {
              userId_factKey: {
                userId,
                factKey: factKey,
              },
            },
            create: {
              userId,
              factKey: factKey,
              factValue: valueStr,
              source: 'onboarding',
              confidence: 1.0,
            },
            update: {
              factValue: valueStr,
              source: 'onboarding',
              confidence: 1.0,
              updatedAt: new Date(),
            },
          });
        }

        // Update onboarding status
        await tx.user.update({
          where: { id: userId },
          data: {
            onboardingStatus: 'COMPLETED',
            lastOnboardingAt: new Date(),
          },
        });

        // Rename main thread from "Onboarding" to "Main Thread"
        // Find the user's main thread and update its title
        const mainThread = await tx.chat.findFirst({
          where: {
            project: { userId },
            isMain: true,
          },
        });

        if (mainThread) {
          await tx.chat.update({
            where: { id: mainThread.id },
            data: { title: 'Main Thread' },
          });
        }
      });

      return {
        success: true,
        content: JSON.stringify({
          message: 'Onboarding completed successfully!',
          saved_facts: Object.keys(facts),
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Failed to complete onboarding',
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};

/**
 * Tool to read a user fact
 */
export const readUserFactTool: ToolDefinition = {
  name: 'read_user_fact',
  description: 'Read stored facts about the user. If fact_key is provided, returns that specific fact. If omitted, returns all ACTIVE facts.',
  parameters: [
    {
      name: 'fact_key',
      type: 'string',
      description: 'The key/label for the fact to retrieve (e.g., "name", "timezone"). Omit to retrieve all ACTIVE facts.',
      required: false,
    },
  ],
  execute: async (args, context): Promise<ToolResult> => {
    const { fact_key } = args;
    const userId = (context?.request as any)?.userId;

    if (!userId) {
      return {
        success: false,
        content: JSON.stringify({ error: 'User not authenticated' }),
      };
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { onboardingStatus: true },
      });

      if (user?.onboardingStatus === 'IN_PROGRESS') {
        return {
          success: true,
          content: JSON.stringify({
            message: 'Onboarding in progress - facts temporarily unavailable',
            facts: [],
          }),
        };
      }

      // If no key provided, return all ACTIVE facts
      if (!fact_key) {
        const facts = await prisma.userFact.findMany({
          where: { userId, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
        });

        return {
          success: true,
          content: JSON.stringify({
            facts: facts.map(f => ({
              key: f.factKey,
              value: f.factValue,
              source: f.source,
              confidence: f.confidence,
            })),
          }),
        };
      }

      const fact = await prisma.userFact.findUnique({
        where: {
          userId_factKey: {
            userId,
            factKey: fact_key,
          },
        },
      });

      if (!fact) {
        return {
          success: true,
          content: JSON.stringify({
            message: `No fact found with key "${fact_key}"`,
            facts: [],
          }),
        };
      }

      return {
        success: true,
        content: JSON.stringify({
          facts: [{
            key: fact.factKey,
            value: fact.factValue,
            source: fact.source,
            confidence: fact.confidence,
          }],
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Failed to read fact',
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
