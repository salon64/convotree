import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { ConvoNode, ConvoTree, ContextMode, LLMClient } from "./models/types.js";
import { insertTree, insertNode, listTrees } from "./db/queries.js";
import { Orchestrator } from "./agents/orchestrator.js";

// ─── Tree / Session Factories ──────────────────────────────────────────────────
// Bootstrap that used to live inline in the CLI, so any consumer (CLI, MCP, tests)
// can create or open a tree without reinventing it.

export interface CreateTreeOptions {
  name: string;
  goal: string;
  contextMode?: ContextMode;
}

export function createTree(
  db: Database.Database,
  llm: LLMClient,
  opts: CreateTreeOptions
): Orchestrator {
  const { name, goal, contextMode = "full_context" } = opts;
  const now = new Date().toISOString();
  const treeId = uuid();

  const root: ConvoNode = {
    id: uuid(),
    parent_id: null,
    branch_point_index: null,
    branch_type: "main",
    context_mode: contextMode,
    status: "active",
    goal,
    context_seed: null,
    messages: [],
    summary: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: now,
    updated_at: now,
  };

  const tree: ConvoTree = {
    id: treeId,
    name,
    root_node_id: root.id,
    active_node_id: root.id,
    created_at: now,
    updated_at: now,
  };

  // insertTree before insertNode — nodes.tree_id has an FK to trees.id
  insertTree(db, tree);
  insertNode(db, treeId, root);

  return new Orchestrator(db, llm, tree);
}

export function openTree(
  db: Database.Database,
  llm: LLMClient,
  treeIdPrefix: string
): Orchestrator {
  const match = listTrees(db).find((t) => t.id.startsWith(treeIdPrefix));
  if (!match) {
    throw new Error(`No tree found with id starting with "${treeIdPrefix}".`);
  }
  return new Orchestrator(db, llm, match);
}
