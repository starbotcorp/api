/**
 * Compactor Service (Clio)
 *
 * Compresses a chat's full message history into a structured, lossless JSON
 * summary and optionally merges newly discovered user traits/abbreviations
 * back into the user profile.
 *
 * Output JSON schema stored in chat.compaction:
 * {
 *   "summary": string,           // 2-3 sentence plain-language summary
 *   "topics": [                  // main topics discussed
 *     { "title": string, "imp": 1-10, "notes": string }
 *   ],
 *   "decisions": string[],       // explicit decisions or conclusions reached
 *   "pendingTasks": string[],    // any open action items mentioned
 *   "userUpdates": {             // newly learned user info to merge into profile
 *     "traits": string[],
 *     "interests": string[],
 *     "facts": { [key]: string },
 *     "abbrev": { [short]: string }
 *   }
 * }
 */

import { getProvider } from '../providers/index.js';
import { prisma } from '../db.js';

// ---- Compaction prompt ----------------------------------------------------- //

function buildCompactionPrompt(opts: {
  messages: Array<{ role: string; content: string }>;
  userName: string;
  abbrevIndex: Record<string, string>;
  projectName: string;
}): string {
  const abbrevLines = Object.entries(opts.abbrevIndex)
    .map(([k, v]) => `  "${k}" → "${v}"`)
    .join('\n');

  const conversationText = opts.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? opts.userName : 'Starbot'}: ${m.content}`)
    .join('\n\n');

  return `You are Clio, Starbot's compactor agent. Your job is to compress a conversation into a lossless structured JSON summary.

## Abbreviation Index (reuse existing shorthands; invent new ones if valuable)
${abbrevLines || '  (none yet)'}

## Project
${opts.projectName}

## Conversation
${conversationText}

---

Produce a JSON object with EXACTLY this structure. No markdown fences, no extra text — only valid JSON:

{
  "summary": "2-3 sentence plain-language summary of what was discussed and accomplished.",
  "topics": [
    { "title": "Topic name", "imp": 8, "notes": "Key details. Use existing abbreviations where possible." }
  ],
  "decisions": [
    "Decision or conclusion that was reached."
  ],
  "pendingTasks": [
    "Open action item that still needs to happen."
  ],
  "userUpdates": {
    "traits": ["new trait discovered about the user, if any"],
    "interests": ["new interest discovered, if any"],
    "facts": { "factKey": "factValue for any newly learned user facts" },
    "abbrev": { "short": "fullTerm for any new abbreviations you are introducing" }
  }
}

Rules:
- imp (importance) is 1–10; 10 = critical context, 1 = trivial detail
- topics should cover ALL main threads of conversation, not just the last one
- decisions and pendingTasks may be empty arrays if none exist
- userUpdates fields may be empty if nothing new was learned
- Be lossless: a reader who only sees this JSON should be able to reconstruct the essential content
- Use abbreviations from the index where helpful; introduce new ones in userUpdates.abbrev
`;
}

// ---- Main compaction function ---------------------------------------------- //

export interface CompactionResult {
  compactionJson: string;            // raw JSON string stored in chat.compaction
  parsed: CompactionOutput;
  mergedTraits: string[];
  mergedInterests: string[];
  newFacts: Array<{ key: string; value: string }>;
  newAbbrev: Record<string, string>;
}

export interface CompactionOutput {
  summary: string;
  topics: Array<{ title: string; imp: number; notes: string }>;
  decisions: string[];
  pendingTasks: string[];
  userUpdates: {
    traits: string[];
    interests: string[];
    facts: Record<string, string>;
    abbrev: Record<string, string>;
  };
}

export async function compactChat(chatId: string, userId: string): Promise<CompactionResult> {
  // Load chat + messages + user profile
  const [chat, user] = await Promise.all([
    prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          where: { role: { in: ['user', 'assistant'] } },
          orderBy: { createdAt: 'asc' },
        },
        project: { select: { name: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        displayName: true,
        name: true,
        traits: true,
        interests: true,
        abbrevIndex: true,
      },
    }),
  ]);

  if (!chat) throw new Error('Chat not found');
  if (!user) throw new Error('User not found');
  if (chat.messages.length < 4) {
    throw new Error('Not enough messages to compact (minimum 4)');
  }

  const userName = user.displayName || user.name || 'User';
  const abbrevIndex = parseJson<Record<string, string>>(user.abbrevIndex, {});
  const projectName = chat.project?.name ?? 'General';

  const prompt = buildCompactionPrompt({
    messages: chat.messages.map(m => ({ role: m.role, content: m.content })),
    userName,
    abbrevIndex,
    projectName,
  });

  // Call the LLM (use deepseek-chat — cheap, fast, good at structured output)
  const provider = getProvider('deepseek');
  let rawOutput = '';

  for await (const chunk of provider.sendChatStream(
    [
      { role: 'system', content: 'You are Clio, a compactor agent. Respond with only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    { model: 'deepseek-chat', maxTokens: 2000, temperature: 0.2 },
  )) {
    if (chunk.text) rawOutput += chunk.text;
  }

  // Strip markdown fences if the model added them anyway
  const cleaned = rawOutput
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: CompactionOutput;
  try {
    parsed = JSON.parse(cleaned) as CompactionOutput;
  } catch {
    throw new Error(`Compactor produced invalid JSON: ${cleaned.slice(0, 300)}`);
  }

  // Ensure required fields exist
  parsed.topics ??= [];
  parsed.decisions ??= [];
  parsed.pendingTasks ??= [];
  parsed.userUpdates ??= { traits: [], interests: [], facts: {}, abbrev: {} };
  parsed.userUpdates.traits ??= [];
  parsed.userUpdates.interests ??= [];
  parsed.userUpdates.facts ??= {};
  parsed.userUpdates.abbrev ??= {};

  // ---- Merge user updates back into the User model ---- //
  const existingTraits = parseJson<string[]>(user.traits, []);
  const existingInterests = parseJson<string[]>(user.interests, []);

  const mergedTraits = Array.from(new Set([...existingTraits, ...parsed.userUpdates.traits]));
  const mergedInterests = Array.from(new Set([...existingInterests, ...parsed.userUpdates.interests]));
  const mergedAbbrev = { ...abbrevIndex, ...parsed.userUpdates.abbrev };

  const newFacts = Object.entries(parsed.userUpdates.facts).map(([key, value]) => ({ key, value }));

  await prisma.$transaction(async (tx) => {
    // Update user profile
    await tx.user.update({
      where: { id: userId },
      data: {
        traits: JSON.stringify(mergedTraits),
        interests: JSON.stringify(mergedInterests),
        abbrevIndex: JSON.stringify(mergedAbbrev),
      },
    });

    // Upsert any new facts learned during conversation
    for (const { key, value } of newFacts) {
      await tx.userFact.upsert({
        where: { userId_factKey: { userId, factKey: key } },
        create: { userId, factKey: key, factValue: value, source: 'compaction', status: 'ACTIVE' },
        update: { factValue: value, source: 'compaction', status: 'ACTIVE', updatedAt: new Date() },
      });
    }

    // Store compaction on the chat
    await tx.chat.update({
      where: { id: chatId },
      data: {
        compaction: cleaned,
        compactedAt: new Date(),
      },
    });
  });

  return {
    compactionJson: cleaned,
    parsed,
    mergedTraits,
    mergedInterests,
    newFacts,
    newAbbrev: parsed.userUpdates.abbrev,
  };
}

// ---- Helper ---------------------------------------------------------------- //

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
