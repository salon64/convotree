import Database from "better-sqlite3";
import { ConvoNode, ConvoTree, Message } from "../models/types.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_node_id  TEXT NOT NULL,
    active_node_id TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id                  TEXT PRIMARY KEY,
    tree_id             TEXT NOT NULL,
    parent_id           TEXT,
    branch_point_index  INTEGER,

    branch_type         TEXT NOT NULL,
    context_mode        TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',

    goal                TEXT NOT NULL,
    context_seed        TEXT,
    messages            TEXT NOT NULL DEFAULT '[]',  -- JSON array of Message
    summary             TEXT,

    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,

    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (tree_id) REFERENCES trees(id),
    FOREIGN KEY (parent_id) REFERENCES nodes(id)
  );
`;

// ─── DB Singleton ────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDB(dbPath: string): Database.Database {
  if (!_db) {
    _db = new Database(dbPath);
    _db.pragma("journal_mode = WAL"); // safer concurrent writes
    _db.exec(SCHEMA);
    migrate(_db);
  }
  return _db;
}

// Additive migrations for DBs created by an earlier version. SQLite's
// `CREATE TABLE IF NOT EXISTS` won't add new columns to an existing table,
// so backfill them here.
function migrate(db: Database.Database): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(nodes)`).all() as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("input_tokens")) {
    db.exec(`ALTER TABLE nodes ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has("output_tokens")) {
    db.exec(`ALTER TABLE nodes ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`);
  }
}

// ─── Tree Queries ────────────────────────────────────────────────────────────

export function insertTree(db: Database.Database, tree: ConvoTree): void {
  db.prepare(`
    INSERT INTO trees (id, name, root_node_id, active_node_id, created_at, updated_at)
    VALUES (@id, @name, @root_node_id, @active_node_id, @created_at, @updated_at)
  `).run(tree);
}

export function getTree(db: Database.Database, id: string): ConvoTree | null {
  return db.prepare(`SELECT * FROM trees WHERE id = ?`).get(id) as ConvoTree | null;
}

export function updateActiveNode(
  db: Database.Database,
  treeId: string,
  nodeId: string
): void {
  db.prepare(`
    UPDATE trees SET active_node_id = ?, updated_at = ? WHERE id = ?
  `).run(nodeId, new Date().toISOString(), treeId);
}

export function listTrees(db: Database.Database): ConvoTree[] {
  return db.prepare(`SELECT * FROM trees ORDER BY updated_at DESC`).all() as ConvoTree[];
}

// ─── Node Queries ─────────────────────────────────────────────────────────────

export function insertNode(
  db: Database.Database,
  treeId: string,
  node: ConvoNode
): void {
  db.prepare(`
    INSERT INTO nodes (
      id, tree_id, parent_id, branch_point_index,
      branch_type, context_mode, status,
      goal, context_seed, messages, summary,
      input_tokens, output_tokens,
      created_at, updated_at
    ) VALUES (
      @id, @tree_id, @parent_id, @branch_point_index,
      @branch_type, @context_mode, @status,
      @goal, @context_seed, @messages, @summary,
      @input_tokens, @output_tokens,
      @created_at, @updated_at
    )
  `).run({
    ...node,
    tree_id: treeId,
    messages: JSON.stringify(node.messages),
  });
}

export function getNode(db: Database.Database, id: string): ConvoNode | null {
  const row = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...row, messages: JSON.parse(row.messages) };
}

export function updateNode(
  db: Database.Database,
  node: Partial<ConvoNode> & { id: string }
): void {
  const updates: string[] = [];
  const values: any = {};

  if (node.messages !== undefined) {
    updates.push("messages = @messages");
    values.messages = JSON.stringify(node.messages);
  }
  if (node.status !== undefined) {
    updates.push("status = @status");
    values.status = node.status;
  }
  if (node.summary !== undefined) {
    updates.push("summary = @summary");
    values.summary = node.summary;
  }
  if (node.context_seed !== undefined) {
    updates.push("context_seed = @context_seed");
    values.context_seed = node.context_seed;
  }
  if (node.input_tokens !== undefined) {
    updates.push("input_tokens = @input_tokens");
    values.input_tokens = node.input_tokens;
  }
  if (node.output_tokens !== undefined) {
    updates.push("output_tokens = @output_tokens");
    values.output_tokens = node.output_tokens;
  }

  updates.push("updated_at = @updated_at");
  values.updated_at = new Date().toISOString();
  values.id = node.id;

  db.prepare(`UPDATE nodes SET ${updates.join(", ")} WHERE id = @id`).run(values);
}

export function getChildren(db: Database.Database, nodeId: string): ConvoNode[] {
  const rows = db.prepare(`
    SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at ASC
  `).all(nodeId) as any[];
  return rows.map((r) => ({ ...r, messages: JSON.parse(r.messages) }));
}

export function getAncestors(
  db: Database.Database,
  nodeId: string
): ConvoNode[] {
  // Walk up the tree from nodeId to root, return in root-first order
  const ancestors: ConvoNode[] = [];
  let current = getNode(db, nodeId);
  while (current?.parent_id) {
    const parent = getNode(db, current.parent_id);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

export function getAllNodes(db: Database.Database, treeId: string): ConvoNode[] {
  const rows = db.prepare(`
    SELECT * FROM nodes WHERE tree_id = ? ORDER BY created_at ASC
  `).all(treeId) as any[];
  return rows.map((r) => ({ ...r, messages: JSON.parse(r.messages) }));
}
