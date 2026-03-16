// Admin docs route — serves all static prompt/document constants for the console viewer
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuthIfEnabled } from '../security/route-guards.js';
import {
  DEFAULT_IDENTITY,
  DEFAULT_PMEMORY,
  DEFAULT_WORKSPACE_MEMORY,
  DEFAULT_CHAT_MEMORY,
} from './memory.js';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../services/orchestrator/orchestrator.js';
import { TITLE_PROMPT } from '../services/title-generator.js';
import {
  ONBOARDING_PROMPT,
  COMPACTION_PROMPT_TEMPLATE,
  PERSONALITY_MATRIX,
} from '../services/prompts.js';
import { prisma } from '../db.js';

export interface StaticDoc {
  id: string;
  label: string;
  description: string;
  content: string;
  group: string;
  liveVersion?: boolean; // true = content is the live DB value, not the compiled default
}

const STATIC_DOCS: StaticDoc[] = [
  {
    id: 'identity_default',
    label: 'IDENTITY.md (default)',
    description: 'Fallback identity injected when no live DB version exists.',
    content: DEFAULT_IDENTITY,
    group: 'Identity',
  },
  {
    id: 'onboarding_prompt',
    label: 'ONBOARDING_PROMPT.md',
    description: 'System prompt injected during new-user onboarding.',
    content: ONBOARDING_PROMPT,
    group: 'Agent Prompts',
  },
  {
    id: 'compaction_prompt',
    label: 'COMPACTION_PROMPT.md',
    description: 'Template prompt used by the Clio compactor agent. Placeholders: {abbrevIndex}, {projectName}, {conversation}.',
    content: COMPACTION_PROMPT_TEMPLATE,
    group: 'Agent Prompts',
  },
  {
    id: 'title_prompt',
    label: 'TITLER_PROMPT.md',
    description: 'Prompt used by the Quill title-generator agent.',
    content: TITLE_PROMPT,
    group: 'Agent Prompts',
  },
  {
    id: 'orchestrator_system',
    label: 'ORCHESTRATOR_SYSTEM.md',
    description: 'Base system prompt for the DeepSeek orchestrator (tool-calling fallback).',
    content: ORCHESTRATOR_SYSTEM_PROMPT,
    group: 'Agent Prompts',
  },
  {
    id: 'personality_matrix',
    label: 'PERSONALITY_MATRIX.md',
    description: 'Maps personalityTone × personalityEngagement grid coordinates to communication styles.',
    content: PERSONALITY_MATRIX,
    group: 'Configuration',
  },
  {
    id: 'project_memory_default',
    label: 'PMEMORY.md (default)',
    description: "Default content for a new project's PMEMORY.md.",
    content: DEFAULT_PMEMORY,
    group: 'Memory Templates',
  },
  {
    id: 'workspace_memory_default',
    label: 'MEMORY.md — Workspace (default)',
    description: "Default content for a new workspace's MEMORY.md.",
    content: DEFAULT_WORKSPACE_MEMORY,
    group: 'Memory Templates',
  },
  {
    id: 'chat_memory_default',
    label: 'MEMORY.md — Chat (default)',
    description: "Default content for a new chat's MEMORY.md.",
    content: DEFAULT_CHAT_MEMORY,
    group: 'Memory Templates',
  },
];

export async function adminDocsRoutes(server: FastifyInstance) {
  // GET /v1/admin/docs — list all static docs + live identity
  server.get('/admin/docs', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    // Fetch the live IDENTITY.md from DB if it exists
    let liveIdentity: StaticDoc | null = null;
    try {
      const identityDoc = await prisma.memoryDocument.findFirst({
        where: { scope: 'identity', projectId: null, workspaceId: null, chatId: null },
        select: { content: true, updatedAt: true },
      });

      if (identityDoc) {
        liveIdentity = {
          id: 'identity_live',
          label: 'IDENTITY.md (live)',
          description: `Live version stored in database. Last updated: ${identityDoc.updatedAt.toLocaleString()}`,
          content: identityDoc.content,
          group: 'Identity',
          liveVersion: true,
        };
      }
    } catch {
      // non-fatal
    }

    const docs = liveIdentity
      ? [liveIdentity, ...STATIC_DOCS]
      : STATIC_DOCS;

    return reply.send({ docs });
  });
}
