// Calculator Tool
// Performs mathematical calculations safely using mathjs

import type { ToolDefinition, ToolResult } from './types.js';
import { evaluate } from 'mathjs';

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Perform mathematical calculations. Supports basic arithmetic, algebra, trigonometry, and more. Use this for any mathematical computation.',
  parameters: [
    {
      name: 'expression',
      type: 'string',
      description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sin(pi/2)", "sqrt(16)")',
      required: true,
    },
  ],
  execute: async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      const expression = String(args.expression || '').trim();
      if (!expression) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Expression is required' }),
        };
      }

      // Evaluate the expression
      const result = evaluate(expression);

      // Convert result to string
      const resultStr = typeof result === 'object'
        ? JSON.stringify(result)
        : String(result);

      return {
        success: true,
        content: JSON.stringify({
          expression,
          result: resultStr,
        }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Failed to evaluate expression: ${errorMessage}`,
        }),
      };
    }
  },
};
