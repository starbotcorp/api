// Generation route (streaming with real model routing)
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { listModels, type ModelDefinition } from '../services/model-catalog.js';
import { interpretUserMessage } from '../services/interpreter.js';
import { classifyWithCodex, serializeHeader, stripHeader, type CodexHeader } from '../services/codex-router.js';
import { getProvider } from '../providers/index.js';
import type { ProviderMessage, ToolCall } from '../providers/types.js';
import { getChatMemoryContext, getIdentityContext, getRelevantContext, getUserFactsContext, isOnboardingComplete } from '../services/retrieval.js';
import { formatWebSearchContext, searchWeb } from '../services/web-search.js';
import { toolRegistry, getToolsByNames } from '../services/tools/index.js';
import { DeepSeekOrchestrator } from '../services/orchestrator/index.js';
import { env } from '../env.js';
import { runTriage } from '../services/triage/index.js';
import { enforceRateLimitIfEnabled, requireAuthIfEnabled, getRealClientIP } from '../security/route-guards.js';
import { getUserTimezone, getCurrentTimeInTimezone, formatTimeInTimezone } from '../services/timezone.js';
import { generateAndUpdateTitle } from '../services/title-generator.js';
import {
  RunChatSchema,
  CompletionSchema,
  type RunParams,
  sortByCost,
  sortFallbackCandidates,
  resolveRequestedModel,
} from './generation/index.js';
import { fileRoutes } from './generation/file-routes.js';

export async function generationRoutes(server: FastifyInstance) {
  // Register file operation routes
  await server.register(fileRoutes);

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

    // Track request lifecycle for debugging
    const requestId = crypto.randomUUID();
    server.log.info({ requestId, chatId }, 'Generation request started');

    server.log.info({ requestId, chatId }, 'Fetching chat from database');

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

    // Cleanup handler for resources
    let isStreamActive = true;
    const cleanup = () => {
      if (isStreamActive) {
        isStreamActive = false;
        server.log.info({ requestId, chatId }, 'Generation request completed/cleaned up');
      }
    };

    // Ensure cleanup on client disconnect
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    // Helper to send SSE events
    const sendEvent = (type: string, data: any) => {
      if (!isStreamActive) {
        return; // Don't send if stream is closed
      }
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
        reply.raw.write(`event: ${type}\n`);
        reply.raw.write(`data: ${dataStr}\n\n`);
      } catch (e) {
        server.log.error({ err: e, requestId, type, data }, 'Failed to send SSE event');
        cleanup();
      }
    };

    // Check if this is a project-level chat (General Chat) and user needs onboarding
    const userId = (request as any).userId;
    const isProjectLevelChat = !chat.workspaceId && !chat.folderId;
    const userOnboardingComplete = await isOnboardingComplete(userId);
    const needsOnboarding = isProjectLevelChat && !userOnboardingComplete;

    // Check if this is a special onboarding trigger message (from restart flow)
    const lastUserMsgForTrigger = chat.messages[chat.messages.length - 1];
    const isOnboardingTrigger = lastUserMsgForTrigger && lastUserMsgForTrigger.role === 'user' && lastUserMsgForTrigger.content === 'Start onboarding';

    // Handle explicit onboarding trigger (from restart flow)
    if (isOnboardingTrigger && lastUserMsgForTrigger) {
      // Delete the trigger message so it doesn't clutter the conversation
      await prisma.message.delete({
        where: { id: lastUserMsgForTrigger.id },
      });

      // Send the onboarding greeting
      const onboardingGreeting = `Hey there! I'm Starbot — your personal AI assistant. I'm here to help you stay organized, answer questions, and maybe even make you smile. Before we dive in, I'd love to get to know you a little better. Sound good?`;

      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          role: 'assistant',
          content: onboardingGreeting,
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
        content: onboardingGreeting,
        provider: 'system',
        model: 'onboarding',
        modelDisplayName: 'Onboarding',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

      sendEvent('chat.updated', {
        id: chatId,
        title: chat.title,
        updatedAt: updatedAt.toISOString(),
      });

      sendEvent('onboarding.required', {
        status: 'required',
        chatId,
      });

      reply.raw.end();
      return reply;
    }

    // If user needs onboarding and this is their first message, inject onboarding context
    let onboardingContext = '';
    if (needsOnboarding && chat.messages.length <= 1) {
      onboardingContext = `# ONBOARDING MODE

You are in onboarding mode. This user is new and you need to collect essential information about them conversationally.

**Your Goals:**
1. Start with a warm, friendly greeting introducing yourself as Starbot
2. Collect the following information naturally through conversation:
   - **Name** (required)
   - **Timezone** (required - for reminders and scheduling)
   - **Role** (required - e.g., developer, writer, student, etc.)
   - **Preferences** (optional - communication style, interests, etc.)

**Available Tools:**
- \`save_user_fact\` - Save individual facts as you learn them
- \`complete_onboarding\` - Call this when you have collected name, timezone, and role to finish onboarding

**Style:**
- Be warm, quirky, and approachable
- Don't ask for all information at once - have a natural conversation
- After collecting the essentials, summarize and ask if there's anything else they'd like to share
- When done, call \`complete_onboarding\` with all collected facts

Start by greeting the user and asking their name!
`;
    }

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
          selectionTier = baseTier;
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
        selectionTier = baseTier;
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
      server.log.info({ requestId, chatId }, 'Starting memory retrieval (may acquire DB connection)');

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
        server.log.warn({ err, requestId, chatId }, 'Memory retrieval failed');
      }

      server.log.info({ requestId, chatId }, 'Memory retrieval completed, releasing DB connection');

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

      if (body.thinking) {
        sendEvent('status', {
          message: 'Thinking mode enabled: using DeepSeek Reasoner (R1)...',
        });
      }

      // Select model based on thinking mode
      const requestedModelId = body.thinking ? 'deepseek-reasoner' : 'deepseek-chat';
      const primaryModel = await resolveRequestedModel(selectionTier, 'text', requestedModelId);
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

      // Get user's timezone for temporal context
      const clientIP = getRealClientIP(request);
      const userTimezone = await getUserTimezone(request, clientIP);
      const now = new Date();
      const currentTimeUTC = now.toISOString();
      const currentTimeUser = getCurrentTimeInTimezone(userTimezone);
      const chatStartedUser = formatTimeInTimezone(chat.createdAt, userTimezone);

      // Calculate elapsed time since chat started
      const elapsedMs = now.getTime() - chat.createdAt.getTime();
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
      } else {
        elapsedFormatted = 'less than a minute';
      }

      server.log.info({ requestId, chatId, userTimezone, currentTimeUTC, currentTimeUser, elapsedFormatted }, 'Temporal context');

      // Add mode hint to guide response depth (with temporal awareness built in)
      const modeHints: Record<string, string> = {
        quick: `RESPONSE STYLE: Be brief and direct. Focus on the essential answer without extensive elaboration.

TEMPORAL AWARENESS:
- User's timezone: ${userTimezone}
- Current time (UTC): ${currentTimeUTC}
- Current time (user's timezone): ${currentTimeUser}
- Conversation started: ${chatStartedUser}
- Time elapsed since conversation started: ${elapsedFormatted}

When asked about time, date, or timing questions (including "how long have we been talking"), use this information.`,
        standard: `RESPONSE STYLE: Provide a balanced response with reasonable detail and clarity.

TEMPORAL AWARENESS:
- User's timezone: ${userTimezone}
- Current time (UTC): ${currentTimeUTC}
- Current time (user's timezone): ${currentTimeUser}
- Conversation started: ${chatStartedUser}
- Time elapsed since conversation started: ${elapsedFormatted}

When asked about time, date, or timing questions (including "how long have we been talking"), use this information.`,
        deep: `RESPONSE STYLE: Be thorough and comprehensive. Explore nuances, provide detailed explanations, and consider edge cases.

TEMPORAL AWARENESS:
- User's timezone: ${userTimezone}
- Current time (UTC): ${currentTimeUTC}
- Current time (user's timezone): ${currentTimeUser}
- Conversation started: ${chatStartedUser}
- Time elapsed since conversation started: ${elapsedFormatted}

When asked about time, date, or timing questions (including "how long have we been talking"), use this information.`,
      };
      providerMessages.push({
        type: 'message',
        role: 'system',
        content: modeHints[body.mode] || modeHints.standard,
      });

      // Inject onboarding context if user needs onboarding
      if (onboardingContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: onboardingContext,
        });
      }

      // Inject Codex header as system message so downstream model sees routing metadata
      if (codexHeader) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: serializeHeader(codexHeader) + '\nThe above header classifies this request. Use it to guide your response style, depth, and tool usage.',
        });
      }

      if (identityContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: identityContext,
        });
      }

      // Inject user facts for personalization
      try {
        const userFactsContext = await getUserFactsContext(userId);
        if (userFactsContext) {
          providerMessages.push({
            type: 'message',
            role: 'system',
            content: userFactsContext,
          });
        }
      } catch (err) {
        server.log.warn({ err, requestId, userId }, 'User facts retrieval failed');
      }

      if (chatMemoryContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: chatMemoryContext,
        });
      }

      if (webSearchContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: webSearchContext,
        });
      }

      if (memoryContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: memoryContext,
        });
      }

      if (taskContext) {
        providerMessages.push({
          type: 'message',
          role: 'system',
          content: taskContext,
        });
      }

      // Add conversation messages
      providerMessages.push(
        ...chat.messages.map((m: { role: string; content: string; createdAt: Date }, idx: number) => {
          const messageContent = idx === lastUserIndex ? interpretedUserMessage : m.content;

          if (m.role === 'tool') {
            return {
              type: 'message' as const,
              role: 'assistant' as const,
              content: `[Tool Result]\n${messageContent}`,
            };
          }
          return {
            type: 'message' as const,
            role: m.role as 'user' | 'assistant' | 'system',
            content: messageContent,
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
        const orchMessages = providerMessages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content || '',
        }));

        // Create and run the orchestrator with identity context
        const orchestrator = new DeepSeekOrchestrator(
          `${primaryModel.provider}:${primaryModel.deploymentName}`,
          { maxIterations: 5, includeReasoning: true }
        );

        const orchResult = await orchestrator.run(
          lastUserMsg.content,
          orchMessages,
          {
            projectId: chat.projectId,
            workspaceId: chat.workspaceId || undefined,
            chatId: chat.id,
            chatCreated: chat.createdAt,
            messageCount: chat.messages.length,
            userTimezone: userTimezone,
            identityContext: identityContext || '',  // Pass the Starbot identity
          }
        );

        // Build full response with thinking tags if reasoning exists
        if (orchResult.reasoning) {
          fullResponse = `<thinking>${orchResult.reasoning}</thinking>${orchResult.response}`;
        } else {
          fullResponse = orchResult.response;
        }

        // Stream the response back
        sendEvent('message.start', {});

        // Stream thinking content first if present
        if (orchResult.reasoning) {
          for (const char of orchResult.reasoning) {
            sendEvent('token.delta', { text: char, reasoning: true });
          }
        }

        // Stream main response
        for (const char of orchResult.response) {
          sendEvent('token.delta', { text: char });
        }

        sendEvent('message.final', {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: fullResponse,
          usage: { promptTokens: 0, completionTokens: fullResponse.length, totalTokens: fullResponse.length },
        });
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

        // Save assistant message (with thinking tags included)
        await prisma.message.create({
          data: {
            chatId,
            role: 'assistant',
            content: fullResponse,
          },
        });

        // Update chat title and generate smart title in background
        const isNewChat = chat.title === 'New Chat';
        const initialTitle = isNewChat
          ? interpretedUserMessage.slice(0, 50) + (interpretedUserMessage.length > 50 ? '...' : '')
          : chat.title;

        const updatedAt = new Date();
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt, title: initialTitle },
        });

        sendEvent('chat.updated', {
          id: chatId,
          title: initialTitle,
          updatedAt: updatedAt.toISOString(),
        });

        // Generate smart title in background for new chats
        if (isNewChat) {
          generateAndUpdateTitle(
            chatId,
            lastUserMsg.content,
            (updatedChatId, newTitle) => {
              sendEvent('chat.updated', {
                id: updatedChatId,
                title: newTitle,
                updatedAt: new Date().toISOString(),
              });
            }
          );
        }

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
              maxTokens: candidate.maxOutputTokens,
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
                type: 'message',
                role: 'assistant',
                content: fullResponse || '',
                tool_calls: toolCalls,
              });

              // Execute each tool
              for (const toolCall of toolCalls) {
                const toolStartTime = Date.now();

                // Fix #10: Proper JSON parsing with error handling
                let parsedArgs: Record<string, unknown>;
                try {
                  parsedArgs = JSON.parse(toolCall.arguments);
                } catch (e) {
                  // Reject invalid tool calls instead of silently defaulting
                  sendEvent('tool.error', {
                    tool_call_id: toolCall.id,
                    tool_name: toolCall.name,
                    error: 'Invalid JSON in tool arguments',
                    raw_arguments: toolCall.arguments,
                  });

                  providerMessages.push({
                    type: 'message',
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.name,
                    content: JSON.stringify({
                      error: 'Failed to parse tool arguments as JSON',
                      raw_arguments: toolCall.arguments,
                    }),
                  });
                  continue;
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
                    type: 'message',
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

                // Fix #10: Validate required parameters
                const missingParams = tool.parameters
                  .filter(p => p.required && !(p.name in parsedArgs))
                  .map(p => p.name);

                if (missingParams.length > 0) {
                  sendEvent('tool.error', {
                    tool_call_id: toolCall.id,
                    tool_name: toolCall.name,
                    error: `Missing required parameters: ${missingParams.join(', ')}`,
                  });

                  providerMessages.push({
                    type: 'message',
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolCall.name,
                    content: JSON.stringify({
                      error: `Missing required parameters: ${missingParams.join(', ')}`,
                      required: tool.parameters.filter(p => p.required).map(p => p.name),
                      provided: Object.keys(parsedArgs),
                    }),
                  });
                  continue;
                }

                try {
                  const result = await tool.execute(parsedArgs);
                  const toolDurationMs = Date.now() - toolStartTime;

                  // Add tool result to provider messages
                  providerMessages.push({
                    type: 'message',
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
                    type: 'message',
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
      const isNewChat = chat.title === 'New Chat';
      const initialTitle = isNewChat
        ? interpretedUserMessage.slice(0, 50) + (interpretedUserMessage.length > 50 ? '...' : '')
        : chat.title;

      const updatedAt = new Date();

      await prisma.chat.update({
        where: { id: chatId },
        data: {
          updatedAt,
          title: initialTitle,
        },
      });

      // 9b. Generate smart title in background for new chats
      if (isNewChat) {
        generateAndUpdateTitle(
          chatId,
          lastUserMsg.content,
          (updatedChatId, newTitle) => {
            // Send SSE event when title is updated
            sendEvent('chat.updated', {
              id: updatedChatId,
              title: newTitle,
              updatedAt: new Date().toISOString(),
            });
          }
        );
      }

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
        title: initialTitle,
        updatedAt: updatedAt.toISOString(),
      });

      reply.raw.end();
      cleanup();
    } catch (err) {
      server.log.error({ err, requestId, chatId }, 'Generation request error');
      sendEvent('error', {
        message: err instanceof Error ? err.message : 'Unknown error',
        fatal: true,
      });
      reply.raw.end();
      cleanup();
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
