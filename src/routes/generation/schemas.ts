import { z } from 'zod';

export const RunChatSchema = z.object({
  mode: z.enum(['quick', 'standard', 'deep']).optional().default('standard'),
  thinking: z.boolean().optional().default(false), // true = deepseek-reasoner (R1), false = deepseek-chat (V3)
  auto: z.boolean().optional().default(true),
  client_context: z
    .object({
      working_dir: z.string().optional(),
    })
    .optional(),
});

export const CompletionSchema = z.object({
  file_path: z.string(),
  content: z.string(),
  cursor_position: z.object({
    line: z.number().min(0),
    column: z.number().min(0),
  }),
  surrounding_lines: z.object({
    before: z.array(z.string()).default([]),
    after: z.array(z.string()).default([]),
  }).default({ before: [], after: [] }),
  max_suggestions: z.number().min(1).max(10).default(3),
  language: z.string().optional(),
});

export const FileListSchema = z.object({
  workspace_id: z.string(),
  path: z.string().default('.'),
});

export const FileReadSchema = z.object({
  workspace_id: z.string(),
  path: z.string(),
});

export const FileWriteSchema = z.object({
  workspace_id: z.string(),
  file_path: z.string(),
  content: z.string(),
  create_backup: z.boolean().default(false),
});

export interface RunParams {
  Params: {
    chatId: string;
  };
}
