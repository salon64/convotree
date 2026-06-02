import chalk from "chalk";
import { ConvoNode } from "../models/types.js";

// ─── Status Colors ────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, (s: string) => string> = {
  active:     chalk.green,
  parked:     chalk.yellow,
  merged:     chalk.cyan,
  abandoned:  chalk.gray,
  deprecated: chalk.red,
};

const BRANCH_ICON: Record<string, string> = {
  main:       "◉",
  tangent:    "◈",
  research:   "◎",
  debug:      "⊗",
  docs:       "◷",
  experiment: "◆",
};

// ─── Renderer ─────────────────────────────────────────────────────────────────

export function renderTree(nodes: ConvoNode[], activeNodeId: string): string {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const childMap = new Map<string | null, ConvoNode[]>();

  for (const node of nodes) {
    const key = node.parent_id ?? null;
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(node);
  }

  const lines: string[] = [];

  function renderNode(node: ConvoNode, prefix: string, isLast: boolean): void {
    const children = childMap.get(node.id) ?? [];
    const connector = isLast ? "└── " : "├── ";
    const icon = BRANCH_ICON[node.branch_type] ?? "○";
    const colorize = STATUS_COLOR[node.status] ?? ((s: string) => s);
    const isActive = node.id === activeNodeId;

    const shortId = node.id.slice(0, 8);
    const msgCount = `(${node.messages.length} msgs)`;
    const label = isActive
      ? chalk.bold.white(`${icon} [ACTIVE] ${node.goal}`)
      : colorize(`${icon} ${node.goal}`);
    const meta = chalk.dim(`${shortId} · ${node.branch_type} · ${node.status} · ${msgCount}`);

    lines.push(`${prefix}${connector}${label}`);
    lines.push(`${prefix}${isLast ? "    " : "│   "}${chalk.dim("    ")}${meta}`);

    const childPrefix = prefix + (isLast ? "    " : "│   ");
    children.forEach((child, i) => {
      renderNode(child, childPrefix, i === children.length - 1);
    });
  }

  // Start from roots (nodes with no parent)
  const roots = childMap.get(null) ?? [];
  roots.forEach((root, i) => {
    renderNode(root, "", i === roots.length - 1);
  });

  return lines.join("\n");
}

// ─── Legend ──────────────────────────────────────────────────────────────────

export function renderLegend(): string {
  const types = Object.entries(BRANCH_ICON)
    .map(([k, v]) => `${v} ${k}`)
    .join("  ");
  const statuses = Object.entries(STATUS_COLOR)
    .map(([k, fn]) => fn(k))
    .join("  ");

  return [
    chalk.dim("─── Types: ") + chalk.dim(types),
    chalk.dim("─── Status: ") + statuses,
  ].join("\n");
}
