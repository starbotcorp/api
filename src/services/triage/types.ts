// Triage System Types for Starbot_API
// Simplified version focused on core categorization and routing

export type TriageCategory =
  | 'CHAT_QA'           // Simple conversation
  | 'BRAINSTORM'        // Ideation
  | 'WRITE_REWRITE'     // Content writing
  | 'SUMMARIZE'         // Summarization
  | 'EXTRACT_STRUCTURE' // Data extraction
  | 'RESEARCH_COMPARE'  // Research/comparison
  | 'PLAN_DESIGN'       // Planning/design
  | 'CODE_EXPLAIN'      // Code explanation
  | 'DEBUG'             // Bug fixing
  | 'CODE_CHANGE'       // Code implementation
  | 'CLI_OPS'           // Command-line operations
  | 'META_TRACE';       // System queries

export type TriageLane =
  | 'quick'    // Tier 1: Fast & cheap
  | 'standard' // Tier 2: Balanced
  | 'deep';    // Tier 3: Premium

export interface TriageInput {
  user_message: string;
  attachments?: Array<{
    type: 'image' | 'text' | 'file';
    filename?: string;
  }>;
  context_summary?: string;
  mode?: 'quick' | 'standard' | 'deep'; // User-requested mode
}

export interface TriageSignals {
  // Attachments
  has_image_attachment: boolean;
  has_file_attachment: boolean;
  has_code_block: boolean;
  has_stack_trace: boolean;
  has_command_snippet: boolean;

  // Intent signals
  asks_for_implementation: boolean;
  asks_for_explanation: boolean;
  asks_for_summary: boolean;
  asks_for_rewrite: boolean;
  asks_for_extraction: boolean;
  asks_for_comparison: boolean;
  asks_for_plan: boolean;
  asks_for_debug: boolean;
  asks_for_brainstorm: boolean;
  asks_for_quick: boolean;
  asks_for_deep: boolean;

  // Complexity signals
  long_input: boolean;
  short_input: boolean;
  detected_languages: string[];
  complexity_score: number; // 1-5

  // Metadata
  estimated_input_tokens: number;
  estimated_context_tokens: number;
}

export interface TriageDecision {
  category: TriageCategory;
  lane: TriageLane;
  complexity: number; // 1-5
  needs_vision: boolean;
  reason_codes: string[];
  safety_notes: string[];
}

export interface TriageResult {
  decision: TriageDecision;
  signals: TriageSignals;
  elapsed_ms: number;
}
