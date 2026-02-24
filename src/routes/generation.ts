// Generation route (streaming with real model routing)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import {
  getBestModelForTier,
  getModelById,
  getModelByProviderAndName,
  listModels,
  type ModelDefinition,
} from '../services/model-catalog.js';
import { interpretUserMessage } from '../services/interpreter.js';
import { classifyWithCodex, serializeHeader, stripHeader, type CodexHeader } from '../services/codex-router.js';
import { getProvider } from '../providers/index.js';
import type { ProviderMessage, ToolCall } from '../providers/types.js';
import { getChatMemoryContext, getIdentityContext, getRelevantContext } from '../services/retrieval.js';
import { formatWebSearchContext, searchWeb } from '../services/web-search.js';
import { toolRegistry, getToolsByNames } from '../services/tools/index.js';
import { DeepSeekOrchestrator } from '../services/orchestrator/index.js';
import { env } from '../env.js';
import { runTriage } from '../services/triage/index.js';
import { enforceRateLimitIfEnabled, requireAuthIfEnabled } from '../security/route-guards.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const RunChatSchema = z.object({
  mode: z.enum(['quick', 'standard', 'deep']).optional().default('standard'),
  model_prefs: z.string().optional(),
  speed: z.boolean().optional().default(false),
  auto: z.boolean().optional().default(true),
  client_context: z
    .object({
      working_dir: z.string().optional(),
    })
    .optional(),
});

const CompletionSchema = z.object({
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

const FileListSchema = z.object({
  workspace_id: z.string(),
  path: z.string().default('.'),
});

const FileReadSchema = z.object({
  workspace_id: z.string(),
  path: z.string(),
});

const FileWriteSchema = z.object({
  workspace_id: z.string(),
  file_path: z.string(),
  content: z.string(),
  create_backup: z.boolean().default(false),
});

interface RunParams {
  Params: {
    chatId: string;
  };
}

const KNOWN_PROVIDERS = new Set(['kimi', 'vertex', 'azure', 'bedrock', 'cloudflare']);

function parseModelPrefs(raw?: string): { provider?: string; model?: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  if (trimmed.includes(':')) {
    const [providerRaw, modelRaw] = trimmed.split(':', 2);
    const provider = providerRaw.trim().toLowerCase();
    const model = modelRaw.trim();
    return {
      provider: provider || undefined,
      model: model || undefined,
    };
  }
  const lower = trimmed.toLowerCase();
  if (KNOWN_PROVIDERS.has(lower)) {
    return { provider: lower };
  }
  return { model: trimmed };
}

function sortByCost(models: ModelDefinition[]): ModelDefinition[] {
  return [...models].sort((a, b) => {
    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  });
}

function sortFallbackCandidates(models: ModelDefinition[], targetTier: number): ModelDefinition[] {
  return [...models].sort((a, b) => {
    const aTierDistance = Math.abs(a.tier - targetTier);
    const bTierDistance = Math.abs(b.tier - targetTier);
    if (aTierDistance !== bTierDistance) return aTierDistance - bTierDistance;

    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  });
}

async function resolveRequestedModel(
  tier: number,
  capability: string,
  modelPrefs?: string,
): Promise<ModelDefinition | null> {
  const prefs = parseModelPrefs(modelPrefs);

  if (prefs.model) {
    if (prefs.provider) {
      const exact = await getModelByProviderAndName(prefs.provider, prefs.model);
      if (exact && exact.status === 'enabled') return exact;
    }

    const byId = await getModelById(prefs.model);
    if (byId && byId.status === 'enabled' && (!prefs.provider || byId.provider === prefs.provider)) {
      return byId;
    }

    const all = await listModels({
      status: 'enabled',
      capability,
      configuredOnly: true,
      ...(prefs.provider ? { provider: prefs.provider } : {}),
    });
    const byDeployment = all.find(m => m.deploymentName === prefs.model);
    if (byDeployment) return byDeployment;
  }

  if (prefs.provider) {
    const atTier = await listModels({
      status: 'enabled',
      tier,
      capability,
      configuredOnly: true,
      provider: prefs.provider,
    });
    if (atTier.length > 0) return sortByCost(atTier)[0];

    const anyTier = await listModels({
      status: 'enabled',
      capability,
      configuredOnly: true,
      provider: prefs.provider,
    });
    if (anyTier.length > 0) return sortByCost(anyTier)[0];
  }

  return getBestModelForTier(tier, capability, true);
}

export async function generationRoutes(server: FastifyInstance) {
  // GET /v1/files/list - List files in directory
  server.get('/files/list', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, path: dirPath } = FileListSchema.parse(request.query);

    try {
      // Use the provided path directly. In production, you'd map workspace_id to actual paths
      let fullPath;
      if (dirPath.startsWith('/')) {
        fullPath = dirPath;
      } else {
        // For relative paths, use a default workspace directory
        const workspacePath = `/workspace/${workspace_id}`;
        fullPath = path.join(workspacePath, dirPath);
      }
      const items = await fs.readdir(fullPath, { withFileTypes: true });

      const files = await Promise.all(items.map(async (item) => {
        const itemPath = path.join(fullPath, item.name);
        const stats = await fs.stat(itemPath);

        return {
          name: item.name,
          path: path.join(dirPath, item.name).replace(/^\//, ''),
          is_dir: item.isDirectory(),
          size: stats.size,
          last_modified: stats.mtime.toISOString(),
        };
      }));

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          files: files.sort((a, b) => {
            // Directories first, then alphabetically
            if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
            return a.name.localeCompare(b.name);
          }),
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({
        error: 'Failed to list files',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // GET /v1/files/read - Read file contents
  server.get('/files/read', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, path: filePath } = FileReadSchema.parse(request.query);

    try {
      const workspacePath = `/workspace/${workspace_id}`;
      const fullPath = path.join(workspacePath, filePath);

      const content = await fs.readFile(fullPath, 'utf-8');
      const stats = await fs.stat(fullPath);

      // Detect language from file extension
      const ext = path.extname(filePath).toLowerCase();
      const languageMap: Record<string, string> = {
        '.js': 'javascript',
        '.ts': 'typescript',
        '.py': 'python',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
        '.cpp': 'cpp',
        '.c': 'c',
        '.h': 'c',
        '.cs': 'csharp',
        '.php': 'php',
        '.rb': 'ruby',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.scala': 'scala',
        '.md': 'markdown',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.toml': 'toml',
        '.xml': 'xml',
        '.html': 'html',
        '.css': 'css',
        '.sql': 'sql',
        '.sh': 'bash',
        '.bash': 'bash',
        '.fish': 'fish',
        '.zsh': 'zsh',
        '.ps1': 'powershell',
        '.dockerfile': 'dockerfile',
      };

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          content,
          language: languageMap[ext] || 'text',
          line_count: content.split('\n').length,
          file_path: filePath,
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(404).send({
        error: 'File not found',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // POST /v1/files/write - Write/create file
  server.post('/files/write', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, file_path, content, create_backup } = FileWriteSchema.parse(request.body);

    try {
      const workspacePath = `/workspace/${workspace_id}`;
      const fullPath = path.join(workspacePath, file_path);

      // Create backup if requested and file exists
      let backupPath: string | undefined;
      if (create_backup) {
        try {
          const stats = await fs.stat(fullPath);
          const backupDir = path.join(workspacePath, '.backups');
          await fs.mkdir(backupDir, { recursive: true });

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupFileName = `${path.basename(file_path)}.${timestamp}.bak`;
          backupPath = path.join(backupDir, backupFileName);

          await fs.copyFile(fullPath, backupPath);
        } catch (err) {
          // File doesn't exist, no backup needed
        }
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');

      // Get diff if backup exists
      let diff: { old: string; new: string } | undefined;
      if (backupPath) {
        const oldContent = await fs.readFile(backupPath, 'utf-8');
        diff = { old: oldContent, new: content };
      }

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          success: true,
          backup_path: backupPath,
          diff,
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({
        error: 'Failed to write file',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // POST /v1/chats/:chatId/run - Start generation (SSE streaming)
  server.post<RunParams>('/chats/:chatId/run', async (request, reply) => {
    const { chatId } = request.params;

    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    if (!enforceRateLimitIfEnabled(request, reply, {
      routeKey: 'run',
      maxRequests: env.RATE_LIMIT_RUN_PER_WINDOW,
    })) {
      return;
    }

    const body = RunChatSchema.parse(request.body);

    // Verify chat exists
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          // Filter out tool messages from DB as defense-in-depth (should not be created by clients)
          where: {
            role: { in: ['user', 'assistant', 'system'] },
          },
          orderBy: { createdAt: 'asc' },
          take: 50, // Last 50 messages for context
        },
        project: true,
        workspace: true,
      },
    });

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    // Set up SSE streaming
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // Helper to send SSE events
    const sendEvent = (type: string, data: any) => {
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
        reply.raw.write(`event: ${type}\n`);
        reply.raw.write(`data: ${dataStr}\n\n`);
      } catch (e) {
        server.log.error({ err: e, type, data }, 'Failed to send SSE event');
      }
    };

    try {
      // 0. Inject task context if chat has associated tasks
      let taskContext = '';
      try {
        const chatTasks = await prisma.task.findMany({
          where: { chat_id: chatId },
          orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
          take: 10,
        });

        if (chatTasks.length > 0) {
          const taskLines = chatTasks.map(t => {
            const status = t.status === 'COMPLETED' ? 'DONE' :
                           t.status === 'IN_PROGRESS' ? 'ACTIVE' :
                           t.status === 'CANCELLED' ? 'CANCELLED' : 'PENDING';
            return `  [${status}] P${t.priority} - ${t.title}${t.description ? `: ${t.description}` : ''} (id: ${t.id})`;
          }).join('\n');

          taskContext = `\n## Current Tasks\nThe following tasks are associated with this conversation:\n${taskLines}\n\nUpdate task status as you make progress. Reference tasks by their IDs.\n`;
        }
      } catch (err) {
        server.log.warn({ err }, 'Task context retrieval failed');
      }

      // 0. Get last user message for interpreter + memory retrieval
      let lastUserIndex = -1;
      for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
        if (chat.messages[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }
      if (lastUserIndex === -1) {
        throw new Error('No user message found in chat');
      }
      const lastUserMsg = chat.messages[lastUserIndex];

      // 0.5 Classification pass — Codex router or legacy interpreter+triage
      let codexHeader: CodexHeader | null = null;
      let interpretation: Awaited<ReturnType<typeof interpretUserMessage>> | null = null;
      let interpretedUserMessage = lastUserMsg.content;
      let category = 'CHAT_QA';
      let lane: 'quick' | 'standard' | 'deep' = 'standard';
      let complexity = 3;
      let selectionTier = 2;
      let codexRouterUsed = false;

      if (env.CODEX_ROUTER_ENABLED) {
        // --- NEW: Codex Header Routing ---
        sendEvent('status', { message: 'Codex router classification...' });
        try {
          codexHeader = await classifyWithCodex(lastUserMsg.content);
          codexRouterUsed = true;

          // Emit classification event (replaces interpreter.debug)
          sendEvent('codex.classification', {
            intent: codexHeader.intent,
            category: codexHeader.category,
            complexity: codexHeader.complexity,
            lane: codexHeader.lane,
            tier: codexHeader.tier,
            tools: codexHeader.tools,
            context_needs: codexHeader.contextNeeds,
            confidence: codexHeader.confidence,
            reasoning: codexHeader.reasoning,
            safety: codexHeader.safety,
          });

          sendEvent('status', {
            message: `Codex: ${codexHeader.intent} / ${codexHeader.category} (tier ${codexHeader.tier}, ${codexHeader.lane})`,
          });

          // Use header fields directly
          category = codexHeader.category;
          lane = codexHeader.lane;
          complexity = codexHeader.complexity;
          const tierMap = { quick: 1, standard: 2, deep: 3 } as const;
          const requestedTier = tierMap[body.mode];
          const baseTier = body.auto ? codexHeader.tier : requestedTier;
          selectionTier = body.speed ? Math.max(1, baseTier - 1) : baseTier;
        } catch (err) {
          server.log.warn({ err }, 'Codex router failed, falling back to interpreter+triage');
          sendEvent('status', { message: 'Codex router failed, using legacy pipeline...' });
          codexHeader = null;
          codexRouterUsed = false;
        }
      }

      // --- FALLBACK: Legacy interpreter + triage pipeline ---
      if (!codexRouterUsed) {
        sendEvent('status', { message: 'Interpreter pass (Cloudflare)...' });
        interpretation = await interpretUserMessage(lastUserMsg.content);
        interpretedUserMessage = interpretation.normalizedUserMessage || lastUserMsg.content;

        sendEvent('interpreter.debug', {
          raw_message: lastUserMsg.content,
          normalized_message: interpretation.normalizedUserMessage,
          primary_intent: interpretation.primaryIntent,
          intents: interpretation.intents,
          confidence: interpretation.confidence,
          reason: interpretation.reason || null,
          should_clarify: interpretation.shouldClarify,
        });

        sendEvent('status', {
          message: `Interpreter intent: ${interpretation.primaryIntent} (${interpretation.intents.join(', ')})`,
        });

        // Run triage for legacy path
        const triageResult = runTriage({
          user_message: interpretedUserMessage,
          mode: body.mode,
        });

        category = triageResult.decision.category;
        lane = triageResult.decision.lane;
        complexity = triageResult.decision.complexity;

        const tierMap = { quick: 1, standard: 2, deep: 3 } as const;
        const triageTier = tierMap[lane];
        const requestedTier = tierMap[body.mode];
        const baseTier = body.auto ? triageTier : requestedTier;
        selectionTier = body.speed ? Math.max(1, baseTier - 1) : baseTier;
      }

      // --- Early returns (clarify, filesystem) ---
      const effectiveIntent = codexHeader?.intent ?? interpretation?.primaryIntent ?? 'chat';

      if (effectiveIntent === 'clarify') {
        const clarification = codexHeader
          ? codexHeader.reasoning || 'Could you clarify what you need?'
          : interpretation?.clarificationQuestion?.trim() || 'Could you clarify what you need?';

        const assistantMessage = await prisma.message.create({
          data: {
            chatId,
            role: 'assistant',
            content: clarification,
          },
        });

        const updatedAt = new Date();
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt },
        });

        sendEvent('message.final', {
          id: assistantMessage.id,
          role: 'assistant',
          content: clarification,
          provider: codexRouterUsed ? 'azure' : 'cloudflare',
          model: codexRouterUsed ? env.CODEX_ROUTER_MODEL : env.INTERPRETER_MODEL,
          modelDisplayName: codexRouterUsed ? 'Codex Router' : 'Interpreter',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          codex: codexHeader ? {
            intent: codexHeader.intent,
            category: codexHeader.category,
            confidence: codexHeader.confidence,
          } : undefined,
        });

        sendEvent('chat.updated', {
          id: chatId,
          title: chat.title,
          updatedAt: updatedAt.toISOString(),
        });

        reply.raw.end();
        return;
      }


      // --- Web search (browse intent or codex context_needs) ---
      let webSearchContext = '';
      const needsWebSearch = codexHeader
        ? (codexHeader.intent === 'browse' || codexHeader.contextNeeds.includes('web_search'))
        : (interpretation?.primaryIntent === 'browse');

      if (needsWebSearch) {
        sendEvent('status', { message: 'Running web search...' });
        try {
          const result = await searchWeb(interpretedUserMessage, 5);
          if (result && result.hits.length > 0) {
            webSearchContext = formatWebSearchContext(result);
            sendEvent('status', { message: `Web search returned ${result.hits.length} result(s).` });
          } else {
            sendEvent('status', { message: 'Web search is unavailable or returned no results.' });
          }
        } catch (err) {
          server.log.warn({ err }, 'Web search failed');
          sendEvent('status', { message: 'Web search failed; continuing without external browse context.' });
        }
      }

      // --- Selective memory retrieval ---
      sendEvent('status', { message: 'Retrieving relevant memory...' });

      let memoryContext = '';
      let identityContext = '';
      let chatMemoryContext = '';

      // Determine what context to fetch based on codex header or default behavior
      const needsIdentity = codexHeader
        ? codexHeader.contextNeeds.includes('identity')
        : true; // legacy always fetches
      const needsWorkspaceMemory = codexHeader
        ? (codexHeader.contextNeeds.includes('workspace_memory') || codexHeader.contextNeeds.includes('project_memory'))
        : true;

      try {
        if (env.MEMORY_V2_ENABLED) {
          const memoryPromises: Promise<string>[] = [];

          if (needsIdentity) {
            memoryPromises.push(getIdentityContext(interpretedUserMessage, 3));
          } else {
            memoryPromises.push(Promise.resolve(''));
          }

          if (needsWorkspaceMemory) {
            memoryPromises.push(getChatMemoryContext(interpretedUserMessage, chatId, 5));
          } else {
            memoryPromises.push(Promise.resolve(''));
          }

          [identityContext, chatMemoryContext] = await Promise.all(memoryPromises);
        } else if (needsWorkspaceMemory) {
          memoryContext = await getRelevantContext(
            interpretedUserMessage,
            chat.projectId,
            chat.workspaceId || undefined,
            5,
          );
        }
      } catch (err) {
        server.log.warn({ err }, 'Memory retrieval failed');
      }

      sendEvent('memory.injected', {
        identity_chunks: identityContext ? 1 : 0,
        chat_chunks: chatMemoryContext ? 1 : 0,
        legacy_chunks: memoryContext ? 1 : 0,
        web_search: !!webSearchContext,
        memory_v2_enabled: env.MEMORY_V2_ENABLED,
        codex_selective: codexRouterUsed,
      });

      // --- Model selection ---
      sendEvent('status', {
        message: body.auto
          ? `Routing auto (${category}/${lane}, complexity: ${complexity})...`
          : `Routing manual (${body.mode}, complexity: ${complexity})...`,
      });

      if (body.speed) {
        sendEvent('status', {
          message: 'Speed mode enabled: preferring a faster model tier...',
        });
      }

      const primaryModel = await resolveRequestedModel(selectionTier, 'text', body.model_prefs);
      if (!primaryModel) {
        throw new Error('No models available. Please configure at least one provider.');
      }

      const fallbackPool = await listModels({
        status: 'enabled',
        capability: 'text',
        configuredOnly: true,
      });
      const fallbackCandidates = sortFallbackCandidates(
        fallbackPool.filter((model) => model.id !== primaryModel.id),
        selectionTier,
      );
      const candidateModels = [primaryModel, ...fallbackCandidates];

      // --- Build provider messages ---
      const providerMessages: ProviderMessage[] = [];

      // Inject Codex header as system message so downstream model sees routing metadata
      if (codexHeader) {
        providerMessages.push({
          role: 'system',
          content: serializeHeader(codexHeader) + '\nThe above header classifies this request. Use it to guide your response style, depth, and tool usage.',
        });
      }

      if (identityContext) {
        providerMessages.push({
          role: 'system',
          content: identityContext,
        });
      }

      if (chatMemoryContext) {
        providerMessages.push({
          role: 'system',
          content: chatMemoryContext,
        });
      }

      if (webSearchContext) {
        providerMessages.push({
          role: 'system',
          content: webSearchContext,
        });
      }

      if (memoryContext) {
        providerMessages.push({
          role: 'system',
          content: memoryContext,
        });
      }

      if (taskContext) {
        providerMessages.push({
          role: 'system',
          content: taskContext,
        });
      }

      // Add conversation messages
      providerMessages.push(
        ...chat.messages.map((m: { role: string; content: string }, idx: number) => {
          if (m.role === 'tool') {
            return {
              role: 'assistant' as const,
              content: `[Tool Result]\n${m.content}`,
            };
          }
          return {
            role: m.role as 'user' | 'assistant' | 'system',
            content: idx === lastUserIndex ? interpretedUserMessage : m.content,
          };
        }),
      );

      // --- Selective tool injection ---
      // Codex header tells us exactly which tools to enable; legacy enables all
      const shouldUseTools = env.TOOLS_ENABLED && toolRegistry.getAll().length > 0;
      const activeTools = (codexHeader && codexHeader.tools.length > 0)
        ? getToolsByNames(codexHeader.tools)
        : (shouldUseTools ? toolRegistry.getAll() : []);
      const toolsEnabled = shouldUseTools && activeTools.length > 0;
      const maxToolIterations = 5;
      let toolIterations = 0;
      let continueWithTools = true;

      // Pre-declare for both paths
      let fullResponse = '';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      // --- DeepSeek Orchestrator Mode ---
      // Using orchestrator for text-based tool parsing
      const isDeepSeek = primaryModel?.id.includes('deepseek');
      const useOrchestrator = isDeepSeek;

      if (useOrchestrator) {
        sendEvent('status', { message: 'Using DeepSeek orchestrator mode...' });

        // Build orchestrator messages from the conversation
        const orchMessages = providerMessages.slice(1).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        }));

        // Create and run the orchestrator
        const orchestrator = new DeepSeekOrchestrator(
          `${primaryModel.provider}:${primaryModel.deploymentName}`,
          { maxIterations: 5, includeReasoning: true }
        );

        const orchResult = await orchestrator.run(
          lastUserMsg.content,
          orchMessages,
          { projectId: chat.projectId, workspaceId: chat.workspaceId || undefined }
        );

        // Stream the response back
        sendEvent('message.start', {});
        for (const char of orchResult.response) {
          sendEvent('token.delta', { text: char });
          fullResponse += char;
        }
        sendEvent('message.stop', {});

        // Send tool results as metadata
        if (orchResult.toolResults.length > 0) {
          sendEvent('tools.executed', {
            tools: orchResult.toolResults.map(t => ({
              name: t.tool,
              success: t.success,
              durationMs: t.durationMs,
            })),
          });
        }

        // Save assistant message
        await prisma.message.create({
          data: {
            chatId,
            role: 'assistant',
            content: fullResponse,
          },
        });

        sendEvent('inference.complete', {
          model: primaryModel.displayName,
          provider: primaryModel.provider,
          tokens: usage,
        });

        reply.raw.end();
        return reply;
      }

      // 6a. Tool execution loop - multi-turn agentic system
      // fullResponse and usage already declared above
      let selectedModel: ModelDefinition | null = null;
      let lastProviderError: unknown = null;
      const blockedProviders = new Set<string>();

      while (continueWithTools && toolIterations < maxToolIterations) {
        toolIterations++;

        // Prepare tool definitions for this iteration (selective based on codex header)
        const toolDefinitions = toolsEnabled
          ? activeTools.map(tool => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                  type: 'object' as const,
                  properties: Object.fromEntries(
                    tool.parameters.map(p => [p.name, {
                      type: p.type,
                      description: p.description,
                      ...(p.enum ? { enum: p.enum } : {}),
                      ...(p.default !== undefined ? { default: p.default } : {}),
                    }]),
                  ),
                  required: tool.parameters.filter(p => p.required).map(p => p.name),
                },
              },
            }))
          : undefined;

        // Try each model candidate for this iteration
        for (let candidateIndex = 0; candidateIndex < candidateModels.length; candidateIndex++) {
          const candidate = candidateModels[candidateIndex];
          if (blockedProviders.has(candidate.provider)) {
            continue;
          }

          if (toolIterations === 1) {
            sendEvent('status', {
              message: `Using ${candidate.displayName} (${candidate.provider})...`,
            });
          } else {
            sendEvent('status', {
              message: `Continuing with ${candidate.displayName} (tool iteration ${toolIterations})...`,
            });
          }

          try {
            const provider = getProvider(candidate.provider);
            fullResponse = '';
            usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            let toolCalls: ToolCall[] = [];
            let finishReason: string | undefined;

            // Stream from LLM
            // DeepSeek R1 doesn't support function calling on Azure - use text parsing instead
            const modelSupportsTools = candidate.capabilities.includes('tools') && !candidate.id.includes('deepseek');
            const toolsToUse = modelSupportsTools ? toolDefinitions : undefined;
            for await (const chunk of provider.sendChatStream(providerMessages, {
              model: candidate.deploymentName,
              maxTokens: body.speed
                ? Math.min(candidate.maxOutputTokens, 1024)
                : candidate.maxOutputTokens,
              temperature: 0.7,
              tools: toolsToUse,
              tool_choice: toolsEnabled && modelSupportsTools ? 'auto' : undefined,
            })) {
              if (chunk.text) {
                // Handle reasoning/thinking content (DeepSeek R1)
                if (chunk.reasoning) {
                  fullResponse += `<thinking>${chunk.text}</thinking>`;
                  sendEvent('token.delta', { text: chunk.text, reasoning: true });
                } else {
                  fullResponse += chunk.text;
                  sendEvent('token.delta', { text: chunk.text });
                }
              }

              if (chunk.tool_calls) {
                toolCalls = chunk.tool_calls;
              }

              if (chunk.finish_reason) {
                finishReason = chunk.finish_reason;
              }

              if (chunk.usage) {
                usage = chunk.usage;
              }
            }

            if (!fullResponse.trim() && toolCalls.length === 0) {
              throw new Error(`Model "${candidate.displayName}" returned an empty response`);
            }

            selectedModel = candidate;

            // Check if we need to execute tools
            if (finishReason === 'tool_calls' && toolCalls.length > 0) {
              // Add assistant message with tool calls to conversation
              providerMessages.push({
                role: 'assistant',
                content: fullResponse || '',
                tool_calls: toolCalls,
              });

              // Execute each tool
              for (const toolCall of toolCalls) {
                const toolStartTime = Date.now();

                // Parse and log tool arguments
                let parsedArgs: any = {};
                try {
                  parsedArgs = JSON.parse(toolCall.arguments);
                } catch (e) {
                  // Leave as empty object if parsing fails
                }

                sendEvent('tool.arguments', {
                  tool_call_id: toolCall.id,
                  name: toolCall.name,
                  arguments: parsedArgs,
                });

                sendEvent('tool.start', {
                  tool_call_id: toolCall.id,
                  tool_name: toolCall.name,
                  arguments: toolCall.arguments,
                });

                const tool = toolRegistry.get(toolCall.name);
                if (!tool) {
                  const errorResult = JSON.stringify({ error: 'Tool not found' });

                  providerMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.name,
                    content: errorResult,
                  });

                  sendEvent('tool.end', {
                    tool_call_id: toolCall.id,
                    tool_name: toolCall.name,
                    success: false,
                    error: 'Tool not found',
                  });

                  continue;
                }

                try {
                  const args = JSON.parse(toolCall.arguments);
                  const result = await tool.execute(args);
                  const toolDurationMs = Date.now() - toolStartTime;

                  // Add tool result to provider messages
                  providerMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.name,
                    content: result.content,
                  });

                  sendEvent('tool.end', {
                    tool_call_id: toolCall.id,
                    tool_name: toolCall.name,
                    success: result.success,
                    duration_ms: toolDurationMs,
                    preview: result.content.slice(0, 200),
                  });
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);

                  providerMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.name,
                    content: JSON.stringify({ error: errorMessage }),
                  });

                  sendEvent('tool.end', {
                    tool_call_id: toolCall.id,
                    tool_name: toolCall.name,
                    success: false,
                    error: errorMessage,
                  });
                }
              }

              // Continue loop to get final response from LLM
              continue;
            }

            // No tool calls or reached stop - exit loop and save response
            continueWithTools = false;
            break;
          } catch (err) {
            lastProviderError = err;
            const errorMessage = err instanceof Error ? err.message : String(err);
            const isAuthError = /(googleautherror|invalid authentication|unauthorized|no route for that uri|not configured|api key|403|401)/i.test(errorMessage);

            if (isAuthError) {
              blockedProviders.add(candidate.provider);
            }

            server.log.warn(
              { err, provider: candidate.provider, model: candidate.deploymentName },
              'Model run failed, trying fallback',
            );

            // Structured provider error event
            sendEvent('error', {
              type: 'provider_failure',
              provider: candidate.provider,
              model: candidate.deploymentName,
              error_message: errorMessage,
              is_auth_error: isAuthError,
              blocked: isAuthError,
              retrying: candidateIndex < candidateModels.length - 1,
              fallback_available: candidateIndex < candidateModels.length - 1,
            });

            sendEvent('status', {
              message: `${candidate.displayName} unavailable, trying fallback...`,
            });
          }
        }

        if (!selectedModel && toolIterations === 1) {
          throw (
            lastProviderError instanceof Error
              ? lastProviderError
              : new Error('All configured models failed to respond')
          );
        }

        if (!continueWithTools) {
          break;
        }
      }

      if (!selectedModel) {
        throw (
          lastProviderError instanceof Error
            ? lastProviderError
            : new Error('All configured models failed to respond')
        );
      }

      // 7. Strip any header artifacts from response before persisting
      const cleanResponse = stripHeader(fullResponse);

      // 8. Save assistant message
      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          role: 'assistant',
          content: cleanResponse,
        },
      });

      // 9. Update chat title if needed
      const newTitle = chat.title === 'New Chat'
        ? interpretedUserMessage.slice(0, 50) + (interpretedUserMessage.length > 50 ? '...' : '')
        : chat.title;

      const updatedAt = new Date();

      await prisma.chat.update({
        where: { id: chatId },
        data: {
          updatedAt,
          title: newTitle,
        },
      });

      // 10. Send final event
      sendEvent('message.final', {
        id: assistantMessage.id,
        role: 'assistant',
        content: cleanResponse,
        provider: selectedModel.provider,
        model: selectedModel.deploymentName,
        modelDisplayName: selectedModel.displayName,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
        codex: codexHeader ? {
          intent: codexHeader.intent,
          category: codexHeader.category,
          complexity: codexHeader.complexity,
          lane: codexHeader.lane,
          tier: codexHeader.tier,
          tools: codexHeader.tools,
          confidence: codexHeader.confidence,
          reasoning: codexHeader.reasoning,
        } : undefined,
        interpreter: interpretation ? {
          action: 'execute',
          primary_intent: interpretation.primaryIntent,
          intents: interpretation.intents,
          confidence: interpretation.confidence,
          reason: interpretation.reason || null,
        } : undefined,
        triage: {
          category,
          lane,
          complexity,
        },
      });

      sendEvent('chat.updated', {
        id: chatId,
        title: newTitle,
        updatedAt: updatedAt.toISOString(),
      });

      reply.raw.end();
    } catch (err) {
      server.log.error(err);
      sendEvent('error', {
        message: err instanceof Error ? err.message : 'Unknown error',
        fatal: true,
      });
      reply.raw.end();
    }
  });

  // POST /v1/completion - Fast inline code completion
  server.post('/completion', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    if (!enforceRateLimitIfEnabled(request, reply, {
      routeKey: 'completion',
      maxRequests: env.RATE_LIMIT_COMPLETION_PER_WINDOW,
    })) {
      return;
    }

    const body = CompletionSchema.parse(request.body);

    // Determine language from file extension if not provided
    let language = body.language;
    if (!language) {
      const ext = body.file_path.split('.').pop()?.toLowerCase();
      language = ext || 'text';
    }

    // Build completion prompt
    const { line, column } = body.cursor_position;
    const currentLine = body.content.split('\n')[line] || '';
    const prefix = currentLine.slice(0, column);
    const suffix = currentLine.slice(column);

    const context = {
      file_path: body.file_path,
      language,
      prefix,
      suffix,
      before_lines: body.surrounding_lines.before,
      after_lines: body.surrounding_lines.after,
      max_suggestions: body.max_suggestions,
    };

    // Use fast model for completion (tier 1)
    const completionModel = await resolveRequestedModel(1, 'text');
    if (!completionModel) {
      return reply.code(404).send({ error: 'No models available for completion' });
    }

    try {
      const provider = getProvider(completionModel.provider);
      const suggestions: Array<{
        text: string;
        confidence: number;
        type: 'completion' | 'refactor' | 'fix';
        position?: {
          start_line: number;
          start_col: number;
          end_line: number;
          end_col: number;
        };
      }> = [];

      // Quick completion prompt
      const completionPrompt = `You are an AI code completion assistant.

File: ${body.file_path}
Language: ${language}

Context (lines before):
${body.surrounding_lines.before.map((l, i) => `${line - body.surrounding_lines.before.length + i + 1}: ${l}`).join('\n')}

Current line ${line + 1}: ${currentLine}
${' '.repeat(column)}^

Context (lines after):
${body.surrounding_lines.after.map((l, i) => `${line + i + 2}: ${l}`).join('\n')}

Provide up to ${body.max_suggestions} code completion suggestions for the cursor position.
Each suggestion should:
1. Complete the current line or provide relevant code
2. Be syntactically correct for ${language}
3. Match the surrounding code style
4. Be useful and relevant to the context

Format each suggestion as JSON:
{
  "text": "the completed code snippet",
  "confidence": 0.8,
  "type": "completion"
}

Respond with only the JSON array of suggestions, nothing else.`;

      // Get completion
      const startTime = Date.now();
      let completionText = '';

      for await (const chunk of provider.sendChatStream([{
        role: 'user',
        content: completionPrompt,
      }], {
        model: completionModel.deploymentName,
        maxTokens: 200,
        temperature: 0.3, // Lower temperature for more deterministic completions
      })) {
        if (chunk.text) {
          completionText += chunk.text;
        }
      }

      // Parse JSON response
      try {
        const suggestionArray = JSON.parse(completionText);
        for (const item of suggestionArray) {
          if (item.text && typeof item.text === 'string') {
            suggestions.push({
              text: item.text,
              confidence: item.confidence || 0.5,
              type: item.type || 'completion',
            });
          }
        }
      } catch (e) {
        // Fallback to simple completion if JSON parsing fails
        const fallbackSuggestion = prefix + ' ' + (language === 'javascript' ? '// Complete here' : '# Complete here');
        suggestions.push({
          text: fallbackSuggestion,
          confidence: 0.3,
          type: 'completion',
        });
      }

      const elapsed = Date.now() - startTime;

      // Return suggestions
      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: elapsed,
        json: {
          suggestions: suggestions.slice(0, body.max_suggestions),
          model_used: completionModel.displayName,
          language,
          file_path: body.file_path,
          latency_ms: elapsed,
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({
        error: 'Completion failed',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // POST /v1/chats/:chatId/cancel - Cancel ongoing generation
  server.post<RunParams>('/chats/:chatId/cancel', async (request, reply) => {
    const { chatId } = request.params;

    // TODO: Implement cancellation logic with AbortController
    // For now, just return success
    return { ok: true, message: 'Cancellation not yet implemented' };
  });
}
