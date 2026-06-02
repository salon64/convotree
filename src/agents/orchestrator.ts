import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import {
  ConvoNode, ConvoTree, ContextMode, BranchType, LLMClient, Message,
} from "../models/types.js";
import {
  getNode, updateNode, insertNode, updateActiveNode,
  getTree, getChildren, getAllNodes,
} from "../db/queries.js";
import {
  brancherPrompt, BRANCHER_SYSTEM,
  summarizerPrompt, SUMMARIZER_SYSTEM,
  mergerPrompt, MERGER_SYSTEM,
  goalReminderSystem,
} from "../prompts/index.js";

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private db: Database.Database;
  private llm: LLMClient;
  private tree: ConvoTree;
  private activeNode: ConvoNode;

  constructor(db: Database.Database, llm: LLMClient, tree: ConvoTree) {
    this.db = db;
    this.llm = llm;
    this.tree = tree;

    const node = getNode(db, tree.active_node_id);
    if (!node) throw new Error(`Active node ${tree.active_node_id} not found`);
    this.activeNode = node;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  getActiveNode(): ConvoNode {
    return this.activeNode;
  }

  getTreeId(): string {
    return this.tree.id;
  }

  getTreeName(): string {
    return this.tree.name;
  }

  private refreshActive(): void {
    const node = getNode(this.db, this.activeNode.id);
    if (!node) throw new Error("Active node disappeared");
    this.activeNode = node;
  }

  private setActive(nodeId: string): void {
    const node = getNode(this.db, nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    this.activeNode = node;
    updateActiveNode(this.db, this.tree.id, nodeId);
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  // Core conversation turn. Builds the right context payload based on context_mode.

  async chat(userMessage: string, opts?: { webSearch?: boolean }): Promise<string> {
    const node = this.activeNode;

    // Build message history for this turn
    const userMsg: Message = {
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    };

    const history: Message[] = [...node.messages, userMsg];

    // Context construction by mode:
    //  - summary:      this branch's own messages, with goal reminder + seed in the system prompt
    //  - full_context: the reconstructed parent lineage prepended to this branch's messages
    let payload: Message[];
    let systemPrompt: string | undefined;

    if (node.context_mode === "full_context") {
      payload = [...this.fullParentContext(node), ...history];
      systemPrompt = undefined; // rely on full history for fidelity
    } else {
      payload = history;
      systemPrompt = goalReminderSystem(node);
    }

    const llmMessages = payload.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // cache: this is a multi-turn call, so the prefix is reused across turns.
    const response = await this.llm.complete(llmMessages, systemPrompt, {
      cache: true,
      webSearch: opts?.webSearch,
    });

    const assistantMsg: Message = {
      role: "assistant",
      content: response.content,
      timestamp: new Date().toISOString(),
    };

    // Persist messages + accumulate token usage on the node.
    // input_tokens = TOTAL input processed this turn (uncached + cache-read +
    // cache-creation) — otherwise cache-heavy turns (e.g. web_search re-sends)
    // report an artificially tiny input count.
    const updatedMessages = [...history, assistantMsg];
    const u = response.usage;
    const turnInput =
      (u?.input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0);
    const inputTokens = node.input_tokens + turnInput;
    const outputTokens = node.output_tokens + (u?.output_tokens ?? 0);

    updateNode(this.db, {
      id: node.id,
      messages: updatedMessages,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    this.activeNode = {
      ...node,
      messages: updatedMessages,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };

    return response.content;
  }

  // Reconstruct the full conversational context above a node by walking its
  // ancestors root→parent, slicing each ancestor's messages at the branch point
  // where the next node in the chain forked off. Used by full_context branches.
  private fullParentContext(node: ConvoNode): Message[] {
    const segments: Message[][] = [];
    let child: ConvoNode = node;

    while (child.parent_id) {
      const parent = getNode(this.db, child.parent_id);
      if (!parent) break;
      // branch_point_index = index of the last parent message included (null = none)
      const sliceEnd =
        child.branch_point_index == null ? 0 : child.branch_point_index + 1;
      segments.unshift(parent.messages.slice(0, sliceEnd));
      child = parent;
    }

    return segments.flat();
  }

  // ── Branch ─────────────────────────────────────────────────────────────────

  async branch(
    goal: string,
    branchType: BranchType = "tangent",
    contextMode: ContextMode = "summary"
  ): Promise<ConvoNode> {
    const parent = this.activeNode;
    const now = new Date().toISOString();

    let contextSeed: string | null = null;

    // Only run the brancher when there is parent context worth distilling.
    // Folding off an empty parent (e.g. a fresh MCP session root) has nothing to
    // seed from — skip the call to save a round-trip and latency.
    if (contextMode === "summary" && parent.messages.length > 0) {
      const prompt = brancherPrompt(parent.messages, goal, parent.goal);
      const response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        BRANCHER_SYSTEM
      );
      contextSeed = response.content;
    }

    const newNode: ConvoNode = {
      id: uuid(),
      parent_id: parent.id,
      // index of the last parent message included; null when forking an empty parent
      branch_point_index:
        parent.messages.length > 0 ? parent.messages.length - 1 : null,

      branch_type: branchType,
      context_mode: contextMode,
      status: "active",

      goal,
      context_seed: contextSeed,
      messages: [],
      summary: null,

      input_tokens: 0,
      output_tokens: 0,

      created_at: now,
      updated_at: now,
    };

    insertNode(this.db, this.tree.id, newNode);
    this.setActive(newNode.id);

    return newNode;
  }

  // ── Park ───────────────────────────────────────────────────────────────────

  async park(): Promise<{ summary: string; parentNode: ConvoNode }> {
    const node = this.activeNode;

    if (!node.parent_id) {
      throw new Error("Cannot park the root node");
    }

    // Summarize the current branch
    const prompt = summarizerPrompt(node);
    const response = await this.llm.complete(
      [{ role: "user", content: prompt }],
      SUMMARIZER_SYSTEM
    );
    const summary = response.content;

    // Update node: parked + summary stored
    updateNode(this.db, { id: node.id, status: "parked", summary });

    // Return to parent
    const parent = getNode(this.db, node.parent_id);
    if (!parent) throw new Error("Parent node not found");

    this.setActive(parent.id);

    return { summary, parentNode: parent };
  }

  // ── Resume ─────────────────────────────────────────────────────────────────

  resume(nodeId: string): ConvoNode {
    const node = getNode(this.db, nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    this.setActive(nodeId);
    return node;
  }

  // ── Rollback ───────────────────────────────────────────────────────────────
  // Fork a new node from message[index] of the active node.
  // Current node forward is deprecated (not deleted).

  async rollback(
    messageIndex: number,
    asBranchType?: BranchType,
    asContextMode?: ContextMode
  ): Promise<ConvoNode> {
    const node = this.activeNode;
    const now = new Date().toISOString();

    // Validate index
    if (messageIndex < 0 || messageIndex >= node.messages.length) {
      throw new Error(
        `Message index ${messageIndex} out of range (0–${node.messages.length - 1})`
      );
    }

    // Deprecate the current node
    updateNode(this.db, { id: node.id, status: "deprecated" });

    // New node forks from the same parent at the same branch point,
    // with messages sliced up to the rollback index
    const slicedMessages = node.messages.slice(0, messageIndex + 1);

    const newNode: ConvoNode = {
      id: uuid(),
      parent_id: node.parent_id,
      branch_point_index: node.branch_point_index,

      branch_type: asBranchType ?? node.branch_type,
      context_mode: asContextMode ?? node.context_mode,
      status: "active",

      goal: node.goal,
      context_seed: node.context_seed,
      messages: slicedMessages,
      summary: null,

      // token counts reset — usage is re-accrued as the forked node is chatted
      input_tokens: 0,
      output_tokens: 0,

      created_at: now,
      updated_at: now,
    };

    insertNode(this.db, this.tree.id, newNode);
    this.setActive(newNode.id);

    return newNode;
  }

  // ── Merge ──────────────────────────────────────────────────────────────────
  // Summarize a branch and inject the outcome as a patch message into target.

  async merge(branchId: string, targetId?: string): Promise<string> {
    const branch = getNode(this.db, branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);

    const targetNode = targetId
      ? getNode(this.db, targetId)
      : this.activeNode;
    if (!targetNode) throw new Error(`Target node not found`);

    // Summarize the branch (or use existing summary)
    let summary = branch.summary;
    if (!summary) {
      const prompt = summarizerPrompt(branch);
      const response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        SUMMARIZER_SYSTEM
      );
      summary = response.content;
      updateNode(this.db, { id: branch.id, summary });
    }

    // Generate the patch message
    const mergePrompt = mergerPrompt(targetNode, summary, branch.branch_type, branch.goal);
    const patchResponse = await this.llm.complete(
      [{ role: "user", content: mergePrompt }],
      MERGER_SYSTEM
    );

    const patchMessage: Message = {
      role: "assistant",
      content: patchResponse.content,
      timestamp: new Date().toISOString(),
    };

    // Inject patch into target
    const updatedMessages = [...targetNode.messages, patchMessage];
    updateNode(this.db, { id: targetNode.id, messages: updatedMessages });

    // Mark branch as merged
    updateNode(this.db, { id: branch.id, status: "merged" });

    // Refresh active if target was active
    if (targetNode.id === this.activeNode.id) {
      this.activeNode = { ...targetNode, messages: updatedMessages };
    }

    return patchResponse.content;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  export(nodeId?: string): object {
    const node = nodeId
      ? getNode(this.db, nodeId)
      : this.activeNode;
    if (!node) throw new Error("Node not found");

    return {
      node,
      children: getChildren(this.db, node.id),
    };
  }

  // ── Tree View Data ─────────────────────────────────────────────────────────

  getTreeData(): ConvoNode[] {
    return getAllNodes(this.db, this.tree.id);
  }

  // Resolve a node by full id or unique short-id prefix. Shared by the CLI
  // (resume/merge) and the future MCP server so prefix handling lives in one place.
  resolveNode(prefix: string): ConvoNode | null {
    return getAllNodes(this.db, this.tree.id).find((n) => n.id.startsWith(prefix)) ?? null;
  }
}
