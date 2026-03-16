/**
 * Context Loader
 *
 * Assembles the full system-prompt context for a chat request according to the
 * CONTEXTCOMPACTION spec:
 *
 *   • User profile (traits, interests, preferences, philosophy, personality)  — always
 *   • ACTIVE user facts                                                        — always (if onboarding complete)
 *   • Thread compaction summary                                                — if chat has been compacted
 *   • Custom instructions                                                      — if set on the chat
 *   • Project profile                                                          — if set on the project
 *
 * Called from generation.ts instead of the previous ad-hoc fact injection.
 */

import { prisma } from '../db.js';

// ---- Personality matrix -------------------------------------------------- //

const TONE_LABELS = ['professional', 'balanced', 'casual'] as const;
const ENGAGEMENT_LABELS = ['supportive', 'balanced', 'challenging'] as const;

function buildPersonalityLine(tone: number, engagement: number): string {
  const toneLabel = TONE_LABELS[tone] ?? TONE_LABELS[1];
  const engLabel = ENGAGEMENT_LABELS[engagement] ?? ENGAGEMENT_LABELS[1];
  if (tone === 1 && engagement === 1) return ''; // both mid — no extra instruction needed
  return `Communication style: ${toneLabel} tone, ${engLabel} engagement.`;
}

// ---- Safe JSON parse ------------------------------------------------------- //

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- User profile context -------------------------------------------------- //

export interface UserProfileContext {
  profileBlock: string;   // full formatted string to inject as system message
  abbrevIndex: Record<string, string>;
  personalityTone: number;
  personalityEngagement: number;
}

/**
 * Build the user profile context block.
 * Returns empty string when onboarding is IN_PROGRESS (clean slate).
 */
export async function getUserProfileContext(userId: string): Promise<UserProfileContext> {
  const empty: UserProfileContext = {
    profileBlock: '',
    abbrevIndex: {},
    personalityTone: 1,
    personalityEngagement: 1,
  };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      onboardingStatus: true,
      displayName: true,
      name: true,
      personalityTone: true,
      personalityEngagement: true,
      traits: true,
      interests: true,
      preferences: true,
      philosophy: true,
      abbrevIndex: true,
    },
  });

  if (!user) return empty;
  if (user.onboardingStatus === 'IN_PROGRESS') return empty;

  const traits = parseJson<string[]>(user.traits, []);
  const interests = parseJson<string[]>(user.interests, []);
  const preferences = parseJson<Record<string, unknown>>(user.preferences, {});
  const philosophy = parseJson<Record<string, unknown>>(user.philosophy, {});
  const abbrevIndex = parseJson<Record<string, string>>(user.abbrevIndex, {});

  const lines: string[] = ['# User Profile'];

  const displayName = user.displayName || user.name;
  if (displayName) lines.push(`Name: ${displayName}`);

  const personalityLine = buildPersonalityLine(user.personalityTone, user.personalityEngagement);
  if (personalityLine) lines.push(personalityLine);

  if (traits.length > 0) lines.push(`Traits: ${traits.join(', ')}`);
  if (interests.length > 0) lines.push(`Interests: ${interests.join(', ')}`);

  const prefEntries = Object.entries(preferences);
  if (prefEntries.length > 0) {
    lines.push('Preferences:');
    for (const [k, v] of prefEntries) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  const philEntries = Object.entries(philosophy);
  if (philEntries.length > 0) {
    lines.push('Philosophy:');
    for (const [k, v] of philEntries) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  // Only emit the block if there's actually something beyond the header
  const hasContent = lines.length > 1;

  return {
    profileBlock: hasContent ? lines.join('\n') + '\n' : '',
    abbrevIndex,
    personalityTone: user.personalityTone,
    personalityEngagement: user.personalityEngagement,
  };
}

// ---- ACTIVE user facts ----------------------------------------------------- //

/**
 * Returns formatted ACTIVE user facts.
 * Respects onboarding status (empty during IN_PROGRESS).
 */
export async function getActiveUserFactsContext(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingStatus: true },
  });

  if (!user || user.onboardingStatus === 'IN_PROGRESS') return '';

  const facts = await prisma.userFact.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });

  if (facts.length === 0) return '';

  const lines = facts.map(f => `${f.factKey}: ${f.factValue}`);
  return `# User Facts\n\n${lines.join('\n')}\n`;
}

// ---- Chat compaction ------------------------------------------------------- //

/**
 * Returns the stored compaction summary for a chat, if one exists.
 * Format: stringified JSON produced by the compactor agent.
 */
export async function getChatCompactionContext(chatId: string): Promise<string> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { compaction: true, compactedAt: true },
  });

  if (!chat?.compaction) return '';

  return `# Conversation Compaction\nThe following is a structured summary of earlier parts of this conversation (compacted ${chat.compactedAt?.toLocaleDateString() ?? 'previously'}):\n\n${chat.compaction}\n`;
}

// ---- Project profile ------------------------------------------------------- //

export async function getProjectProfileContext(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { profile: true, name: true },
  });

  if (!project?.profile) return '';

  const profile = parseJson<Record<string, unknown>>(project.profile, {});
  if (Object.keys(profile).length === 0) return '';

  const lines = [`# Project Profile: ${project.name}`];
  for (const [k, v] of Object.entries(profile)) {
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return lines.join('\n') + '\n';
}

// ---- Custom instructions --------------------------------------------------- //

export async function getChatCustomInstructions(chatId: string): Promise<string> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { customInstructions: true },
  });

  if (!chat?.customInstructions?.trim()) return '';
  return `# Custom Instructions\n\n${chat.customInstructions.trim()}\n`;
}

// ---- Full context assembly ------------------------------------------------- //

export interface AssembledContext {
  profileBlock: string;
  factsBlock: string;
  compactionBlock: string;
  projectProfileBlock: string;
  customInstructionsBlock: string;
  abbrevIndex: Record<string, string>;
  personalityTone: number;
  personalityEngagement: number;
}

/**
 * Assemble all context blocks for a chat request in one call.
 * Each block is an empty string when not applicable.
 */
export async function assembleContext(opts: {
  userId: string;
  chatId: string;
  projectId: string;
}): Promise<AssembledContext> {
  const [profile, compaction, projectProfile, customInstructions] = await Promise.all([
    getUserProfileContext(opts.userId),
    getChatCompactionContext(opts.chatId),
    getProjectProfileContext(opts.projectId),
    getChatCustomInstructions(opts.chatId),
  ]);

  // Facts come from profile context check (respects onboarding status)
  const factsBlock = await getActiveUserFactsContext(opts.userId);

  return {
    profileBlock: profile.profileBlock,
    factsBlock,
    compactionBlock: compaction,
    projectProfileBlock: projectProfile,
    customInstructionsBlock: customInstructions,
    abbrevIndex: profile.abbrevIndex,
    personalityTone: profile.personalityTone,
    personalityEngagement: profile.personalityEngagement,
  };
}
