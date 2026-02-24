// Stage B: Rules Engine
// Apply deterministic rules to signals → produce TriageDecision

import type { TriageSignals, TriageInput, TriageDecision, TriageCategory, TriageLane } from './types.js';

// Category scoring - higher score wins
function computeCategoryScores(signals: TriageSignals): Record<TriageCategory, number> {
  const scores: Record<TriageCategory, number> = {
    CHAT_QA: 1,           // Base score (default fallback)
    BRAINSTORM: 0,
    WRITE_REWRITE: 0,
    SUMMARIZE: 0,
    EXTRACT_STRUCTURE: 0,
    RESEARCH_COMPARE: 0,
    PLAN_DESIGN: 0,
    CODE_EXPLAIN: 0,
    DEBUG: 0,
    CODE_CHANGE: 0,
    CLI_OPS: 0,
    META_TRACE: 0,
  };

  // Hard rules (highest priority)
  if (signals.has_stack_trace || signals.asks_for_debug) {
    scores.DEBUG += 10;
  }

  if (signals.asks_for_implementation) {
    scores.CODE_CHANGE += 8;
  }

  // Intent-based scoring
  if (signals.asks_for_summary) scores.SUMMARIZE += 5;
  if (signals.asks_for_rewrite) scores.WRITE_REWRITE += 5;
  if (signals.asks_for_extraction) scores.EXTRACT_STRUCTURE += 5;
  if (signals.asks_for_comparison) scores.RESEARCH_COMPARE += 5;
  if (signals.asks_for_plan) scores.PLAN_DESIGN += 5;
  if (signals.asks_for_brainstorm) scores.BRAINSTORM += 5;

  // Code-related scoring
  if (signals.has_code_block) {
    if (signals.asks_for_explanation) {
      scores.CODE_EXPLAIN += 6;
    } else if (signals.has_stack_trace) {
      scores.DEBUG += 5;
    } else {
      scores.CODE_CHANGE += 3;
    }
  }

  if (signals.has_command_snippet) {
    scores.CLI_OPS += 4;
  }

  // Multi-language = likely complex code task
  if (signals.detected_languages.length > 1) {
    scores.CODE_CHANGE += 2;
  }

  return scores;
}

function selectCategory(scores: Record<TriageCategory, number>): TriageCategory {
  let maxScore = 0;
  let selectedCategory: TriageCategory = 'CHAT_QA';

  for (const [category, score] of Object.entries(scores) as Array<[TriageCategory, number]>) {
    if (score > maxScore) {
      maxScore = score;
      selectedCategory = category;
    }
  }

  return selectedCategory;
}

function selectLane(
  signals: TriageSignals,
  complexity: number,
  input: TriageInput
): TriageLane {
  // User explicit request overrides everything
  if (input.mode === 'quick') return 'quick';
  if (input.mode === 'deep') return 'deep';

  // Signal-based overrides
  if (signals.asks_for_quick) return 'quick';
  if (signals.asks_for_deep) return 'deep';

  // Complexity-based selection
  if (complexity <= 2) return 'quick';
  if (complexity === 3) return 'standard';
  return 'deep'; // complexity >= 4
}

function buildReasonCodes(signals: TriageSignals, category: TriageCategory): string[] {
  const reasons: string[] = [];

  // Attachment reasons
  if (signals.has_image_attachment) reasons.push('HAS_IMAGE_ATTACHMENT');
  if (signals.has_code_block) reasons.push('HAS_CODE_BLOCK');
  if (signals.has_stack_trace) reasons.push('HAS_STACK_TRACE');
  if (signals.has_command_snippet) reasons.push('HAS_COMMAND_SNIPPET');

  // Intent reasons
  if (signals.asks_for_implementation) reasons.push('ASKS_FOR_IMPLEMENTATION');
  if (signals.asks_for_explanation) reasons.push('ASKS_FOR_EXPLANATION');
  if (signals.asks_for_summary) reasons.push('ASKS_FOR_SUMMARY');
  if (signals.asks_for_rewrite) reasons.push('ASKS_FOR_REWRITE');
  if (signals.asks_for_extraction) reasons.push('ASKS_FOR_EXTRACTION');
  if (signals.asks_for_comparison) reasons.push('ASKS_FOR_COMPARISON');
  if (signals.asks_for_plan) reasons.push('ASKS_FOR_PLAN');
  if (signals.asks_for_debug) reasons.push('ASKS_FOR_DEBUG');
  if (signals.asks_for_brainstorm) reasons.push('ASKS_FOR_BRAINSTORM');

  // Complexity reasons
  if (signals.long_input) reasons.push('LONG_INPUT');
  if (signals.short_input) reasons.push('SHORT_INPUT');
  if (signals.asks_for_quick) reasons.push('USER_WANTS_QUICK');
  if (signals.asks_for_deep) reasons.push('USER_WANTS_DEEP');
  if (signals.complexity_score >= 4) reasons.push('HIGH_COMPLEXITY');

  // Language reasons
  if (signals.detected_languages.length > 0) {
    reasons.push(`DETECTED_LANGUAGES:${signals.detected_languages.join(',')}`);
  }

  // Category reason
  reasons.push(`CATEGORY:${category}`);

  return reasons;
}

function buildSafetyNotes(signals: TriageSignals): string[] {
  const notes: string[] = [];

  // No specific safety concerns in simplified version
  // Can be extended later for security-sensitive content

  return notes;
}

export function applyRules(signals: TriageSignals, input: TriageInput): TriageDecision {
  // 1. Compute category scores
  const scores = computeCategoryScores(signals);

  // 2. Select winning category
  const category = selectCategory(scores);

  // 3. Estimate final complexity
  let complexity = signals.complexity_score;
  if (category === 'CODE_CHANGE' || category === 'DEBUG') {
    complexity = Math.min(5, complexity + 1); // Code tasks are inherently more complex
  }
  complexity = Math.max(1, Math.min(5, complexity));

  // 4. Select lane (tier)
  const lane = selectLane(signals, complexity, input);

  // 5. Check if vision is needed
  const needs_vision = signals.has_image_attachment;

  // 6. Build reason codes
  const reason_codes = buildReasonCodes(signals, category);

  // 7. Build safety notes
  const safety_notes = buildSafetyNotes(signals);

  return {
    category,
    lane,
    complexity,
    needs_vision,
    reason_codes,
    safety_notes,
  };
}
