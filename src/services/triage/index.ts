// Triage System Entry Point
// Runs Stage A (signal detection) then Stage B (rules engine)

import type { TriageInput, TriageResult } from './types.js';
import { detectSignals } from './signals.js';
import { applyRules } from './rules.js';

export function runTriage(input: TriageInput): TriageResult {
  const start = performance.now();

  // Stage A: Detect signals from user message
  const signals = detectSignals(input);

  // Stage B: Apply rules to produce decision
  const decision = applyRules(signals, input);

  const elapsed_ms = Math.round(performance.now() - start);

  return {
    decision,
    signals,
    elapsed_ms,
  };
}

// Re-export types for convenience
export type { TriageInput, TriageDecision, TriageSignals, TriageResult, TriageCategory, TriageLane } from './types.js';
