/**
 * Builds the checkpoint prompt and completes the model's summary.
 *
 * The prompt carries the whole request: the directives, the conversation being
 * summarized, the previous checkpoint, and the protected facts. After the model
 * writes the summary, completeSummary restores any protected identifier the
 * model dropped and appends the exact file and worktree state.
 */

import {
  extractProtectedFacts,
  formatFileOperationsXml,
  sanitizeTagContent,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
} from "./prompt.ts";
import type { GitEngineeringState } from "./git-state.ts";
import type { SessionFacts } from "./session.ts";

export const RETAINED_IDENTIFIERS_HEADING = "### Retained Identifiers";

const REQUIRED_SECTIONS = [
  /## 1\.\s+Primary Goal/i,
  /## 2\.\s+Progress Ledger/i,
  /## 3\.\s+Code Changes/i,
  /## 4\.\s+Errors/i,
  /## 5\.\s+Key Decisions/i,
  /## 6\.\s+Resume Anchor/i,
];

/** Whether a summary has all six numbered sections; a reply cut off by an output limit usually does not. */
export function isCompleteSummary(text: string): boolean {
  return REQUIRED_SECTIONS.every((section) => section.test(text));
}

const CONVERSATION_OPEN = "<conversation>";
const CONVERSATION_CLOSE = "</conversation>";

// Everything from the first appended state block on is regenerated each time,
// so it is not fed back to the model as part of the previous checkpoint.
const APPENDED_STATE = /\n\n<(?:read-files|touched-files|uncommitted-dirty-files|modified-lockfiles-and-assets|active-background-processes|running-subagents|uncommitted-diff|uncommitted-state-unavailable|recent-context-summarized)\b/i;

export function semanticSummary(summary: string): string {
  return summary.split(APPENDED_STATE)[0]!.trim();
}

export interface Checkpoint {
  prompt: string;
  protectedFacts: string[];
  appendix: string;
}

/** Session state appended after the summary beside the file and worktree state. */
export interface CheckpointState {
  backgroundProcesses?: string[];
  runningSubagents?: string[];
  /** The summary also covers the turns OpenCode keeps verbatim, so the recent context may be shortened in requests. */
  recentSummarized?: boolean;
}

export function buildCheckpoint(
  facts: SessionFacts,
  git: GitEngineeringState,
  { backgroundProcesses = [], runningSubagents = [], recentSummarized = false }: CheckpointState = {},
): Checkpoint {
  const previousSummary = facts.previousSummary ? semanticSummary(facts.previousSummary) : undefined;
  const protectedFacts = extractProtectedFacts(facts.userTexts, previousSummary);

  const sections = [
    SMART_COMPACTION_SYSTEM_PROMPT,
    `${CONVERSATION_OPEN}\n${sanitizeTagContent(facts.transcript)}\n${CONVERSATION_CLOSE}`,
  ];
  if (previousSummary) {
    sections.push(`<previous-summary>\n${sanitizeTagContent(previousSummary)}\n</previous-summary>`);
  }
  if (protectedFacts.length > 0) {
    sections.push(`<protected-facts>\n${protectedFacts.map(sanitizeTagContent).join("\n")}\n</protected-facts>`);
  }
  sections.push(previousSummary ? SMART_COMPACTION_UPDATE_PROMPT : SMART_COMPACTION_INITIAL_PROMPT);

  const appendix = formatFileOperationsXml({
    readFiles: facts.readFiles,
    touchedModifiedFiles: facts.modifiedFiles,
    activeDirtyFiles: git.files.map((file) => file.path),
    dirtyPatch: git.patch,
    dirtyStateAvailable: git.available,
    lockfilesAndGeneratedAssets: git.lockfilesAndGeneratedAssets,
    activeBackgroundProcesses: backgroundProcesses,
    runningSubagents,
    recentSummarized,
  });

  return { prompt: sections.join("\n\n"), protectedFacts, appendix };
}

/** Restore dropped protected identifiers verbatim, then append the file and worktree state. */
export function completeSummary(text: string, checkpoint: Pick<Checkpoint, "protectedFacts" | "appendix">): string {
  let summary = text.trimEnd();
  const dropped = checkpoint.protectedFacts.filter((fact) => fact && !summary.includes(fact));
  if (dropped.length > 0) {
    summary = [summary, "", RETAINED_IDENTIFIERS_HEADING, ...dropped.map((fact) => `- ${fact}`)].join("\n");
  }
  return `${summary}${checkpoint.appendix}`;
}