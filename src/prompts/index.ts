import { BranchType, ConvoNode, Message } from "../models/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMessages(messages: Message[], last_n?: number): string {
  const slice = last_n ? messages.slice(-last_n) : messages;
  return slice
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");
}

// ─── Brancher ─────────────────────────────────────────────────────────────────
// Generates a minimal context seed so the child branch doesn't drown
// in the full parent history.

export const BRANCHER_SYSTEM = `You are a context distiller. Be extremely concise.
Your job is to extract only what a new conversation branch needs to know — not summarize everything.
Respond ONLY with the structured format below, no preamble.`;

export function brancherPrompt(
  parentMessages: Message[],
  branchGoal: string,
  parentGoal: string
): string {
  return `PARENT GOAL: ${parentGoal}

RECENT CONVERSATION (last 6 messages):
${formatMessages(parentMessages, 6)}

NEW BRANCH GOAL: ${branchGoal}

Produce a minimal context seed for the new branch. Include ONLY what is directly relevant to the branch goal.

SITUATION: <1-2 sentences on the current state of the parent work>
RELEVANT CONTEXT: <bullet points — only what this branch needs>
CONSTRAINTS: <decisions already made in parent that this branch must respect>
BRANCH GOAL: <restate the branch goal clearly and specifically>`;
}

// ─── Summarizer ───────────────────────────────────────────────────────────────
// Summarizes a branch when it is parked or before merging.
// Output format differs by branch_type.

export const SUMMARIZER_SYSTEM = `You are a conversation summarizer for a development workflow tool.
Produce a structured summary of the conversation branch.
Be concise but complete — this summary may be the only record used when integrating back into the main thread.
If the conversation includes a "Sources:" list of URLs (e.g. from web search), reproduce those URLs verbatim in a final SOURCES: section so they are not lost.
Respond ONLY with the structured format, no preamble.`;

const SUMMARIZER_FORMATS: Record<BranchType, string> = {
  debug: `PROBLEM: <what was broken or wrong>
ROOT CAUSE: <why it was broken>
FIX: <what was done to resolve it>
SIDE EFFECTS: <anything else changed or discovered>
UNRESOLVED: <anything not fixed — leave blank if none>`,

  research: `QUESTION: <what was being investigated>
FINDINGS: <key conclusions, most confident first>
RECOMMENDATION: <what to do with this information>
OPEN QUESTIONS: <what remains uncertain or needs follow-up>`,

  docs: `ARTIFACT: <the produced documentation — include inline or note where it lives>
COVERS: <what is documented>
GAPS: <what is not yet documented>`,

  experiment: `HYPOTHESIS: <what was being tested or explored>
WHAT WAS TRIED: <approaches taken>
OUTCOME: <what worked, what didn't>
RECOMMENDATION: <what to do next based on this>`,

  tangent: `STARTED FROM: <what triggered this side branch>
EXPLORED: <what was discussed or tried>
CONCLUSION: <outcome or decision reached>
RELEVANCE TO PARENT: <how this affects the parent goal — leave blank if standalone>`,

  main: `PROGRESS: <what was accomplished>
CURRENT STATE: <where things stand now>
NEXT STEPS: <what should happen next>
BLOCKERS: <anything in the way — leave blank if none>`,
};

export function summarizerPrompt(node: ConvoNode): string {
  return `BRANCH TYPE: ${node.branch_type}
BRANCH GOAL: ${node.goal}

FULL CONVERSATION:
${formatMessages(node.messages)}

Summarize this branch using the following format:

${SUMMARIZER_FORMATS[node.branch_type]}`;
}

// ─── Merger ───────────────────────────────────────────────────────────────────
// Produces a single "patch message" that integrates the branch summary
// into the parent node as a natural continuation.

export const MERGER_SYSTEM = `You are integrating the outcome of a completed side branch back into a main conversation.
Do not explain the merge process. Produce a single assistant message as if it were a natural continuation of the parent thread.
Be concise — the goal is to update the parent's working state, not replay the branch.`;

export function mergerPrompt(
  parentNode: ConvoNode,
  branchSummary: string,
  branchType: BranchType,
  branchGoal: string
): string {
  return `PARENT GOAL: ${parentNode.goal}

PARENT CONVERSATION (last 4 messages):
${formatMessages(parentNode.messages, 4)}

BRANCH TYPE: ${branchType}
BRANCH GOAL: ${branchGoal}
BRANCH SUMMARY:
${branchSummary}

Produce a single assistant message that:
1. Acknowledges the branch outcome in one sentence
2. Integrates any decisions, fixes, or findings into the current working state
3. Restates the next logical step in the parent work`;
}

// ─── Goal Reminder ────────────────────────────────────────────────────────────
// Prepended as system context on every LLM call in summary mode
// to keep the branch from drifting.

export function goalReminderSystem(node: ConvoNode): string {
  const seed = node.context_seed
    ? `\n\nCONTEXT FROM PARENT:\n${node.context_seed}`
    : "";

  return `You are working on a focused task. Stay on goal.

BRANCH TYPE: ${node.branch_type}
GOAL: ${node.goal}${seed}

Do not drift from this goal. If the user asks something outside scope, note it and redirect.`;
}
