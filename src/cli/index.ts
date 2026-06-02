#!/usr/bin/env node
import "dotenv/config"; // load .env into process.env before anything reads it
import readline from "readline";
import { Command } from "commander";
import chalk from "chalk";

import { loadConfig, getApiKey, readRawConfig, writeRawConfig, CONFIG_FILE } from "../config.js";
import { getDB, listTrees } from "../db/queries.js";
import { createLLMClient } from "../llm/client.js";
import { listProviders } from "../llm/registry.js";
import { createTree, openTree } from "../session.js";
import type { LLMClient } from "../models/types.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { renderTree, renderLegend } from "./treeRenderer.js";
import { BranchType, ContextMode } from "../models/types.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig();
const db = getDB(config.db_path);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(msg); }
function err(msg: string) { console.error(chalk.red("✗ " + msg)); }
function ok(msg: string)  { console.log(chalk.green("✓ " + msg)); }
function info(msg: string){ console.log(chalk.cyan("ℹ " + msg)); }

// Build the LLM client, or exit with a friendly setup hint if no key is configured.
function requireLLM(): LLMClient {
  try {
    return createLLMClient(config);
  } catch (e: any) {
    err(e.message ?? String(e));
    const p = config.provider;
    info(`Set a key:  convotree config set-key <your-key>${p !== "anthropic" ? ` --provider ${p}` : ""}`);
    info(`(or export ${p.toUpperCase()}_API_KEY).  Check setup:  convotree config`);
    process.exit(1);
  }
}

// ─── Interactive REPL ────────────────────────────────────────────────────────
// Once a tree is loaded/created, drops into a readline loop.
// Lines starting with / are commands; everything else is a chat message.

async function startREPL(orchestrator: Orchestrator, treeName: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  function prompt() {
    const node = orchestrator.getActiveNode();
    const shortId = node.id.slice(0, 6);
    rl.setPrompt(
      chalk.dim(`[${node.branch_type}:${shortId}] `) + chalk.bold("> ")
    );
    rl.prompt();
  }

  log(chalk.bold("\nconvotree") + chalk.dim(` — ${treeName}`));
  log(chalk.dim("Type a message to chat, or /help for commands.\n"));
  prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    try {
      // ── Commands ────────────────────────────────────────────────────────────
      if (input.startsWith("/")) {
        const [cmd, ...args] = input.slice(1).split(" ");

        switch (cmd) {
          case "help": {
            log(`
${chalk.bold("Commands:")}
  /branch <goal> [--type debug|research|docs|tangent|experiment] [--full]
                      Spawn a child branch from the current node
  /park               Summarize and park this branch, return to parent
  /resume <id>        Switch to a different node by ID (first 8 chars ok)
  /rollback <index>   Fork from message[index] of current node, deprecate forward
                      Optional: --as <type> to change branch type
  /merge <id>         Merge a branch's summary into the current node
  /tree               Show the full conversation tree
  /goal               Print the current node's goal
  /status             Print current node metadata
  /export [id]        Dump node as JSON (pipe-friendly)
  /nodes              List all nodes with short IDs
  /quit               Exit
            `);
            break;
          }

          case "branch": {
            // /branch fix the auth bug --type debug --full
            const typeMatch = args.join(" ").match(/--type\s+(\w+)/);
            const fullFlag = args.includes("--full");
            const branchType = (typeMatch?.[1] as BranchType) ?? "tangent";
            // --full forces full_context; otherwise honor the configured default.
            const contextMode: ContextMode = fullFlag ? "full_context" : config.default_context_mode;
            const goal = args
              .join(" ")
              .replace(/--type\s+\w+/, "")
              .replace("--full", "")
              .trim();

            if (!goal) { err("Usage: /branch <goal> [--type <type>] [--full]"); break; }

            info(`Branching: "${goal}" [${branchType}, ${contextMode}]`);
            if (contextMode === "summary") info("Generating context seed...");

            const newNode = await orchestrator.branch(goal, branchType, contextMode);
            ok(`Created branch ${newNode.id.slice(0, 8)} — now active`);
            if (newNode.context_seed) {
              log(chalk.dim("\nContext seed:\n") + chalk.dim(newNode.context_seed));
            }
            break;
          }

          case "park": {
            info("Summarizing branch and parking...");
            const { summary, parentNode } = await orchestrator.park();
            log(chalk.dim("\nSummary:\n") + chalk.dim(summary));
            ok(`Parked. Back to: "${parentNode.goal}" [${parentNode.id.slice(0, 8)}]`);
            break;
          }

          case "resume": {
            const id = args[0];
            if (!id) { err("Usage: /resume <node-id>"); break; }
            // Allow short IDs: resolve the first node whose id starts with the prefix
            const match = orchestrator.resolveNode(id);
            if (!match) { err(`No node found with id starting with "${id}"`); break; }
            const node = orchestrator.resume(match.id);
            ok(`Resumed: "${node.goal}" [${node.branch_type}]`);
            break;
          }

          case "rollback": {
            const index = parseInt(args[0]);
            if (isNaN(index)) { err("Usage: /rollback <message-index> [--as <type>]"); break; }
            const asMatch = args.join(" ").match(/--as\s+(\w+)/);
            const asBranchType = asMatch?.[1] as BranchType | undefined;
            const newNode = await orchestrator.rollback(index, asBranchType);
            ok(`Rolled back to message[${index}]. New node: ${newNode.id.slice(0, 8)}`);
            break;
          }

          case "merge": {
            const id = args[0];
            if (!id) { err("Usage: /merge <branch-id>"); break; }
            const match = orchestrator.resolveNode(id);
            if (!match) { err(`No node found with id starting with "${id}"`); break; }
            info("Summarizing branch and merging...");
            const patch = await orchestrator.merge(match.id);
            log(chalk.dim("\nPatch injected:\n") + chalk.dim(patch));
            ok("Merged.");
            break;
          }

          case "tree": {
            const nodes = orchestrator.getTreeData();
            const activeId = orchestrator.getActiveNode().id;
            log("\n" + renderTree(nodes, activeId));
            log("\n" + renderLegend());
            break;
          }

          case "goal": {
            const node = orchestrator.getActiveNode();
            log(chalk.bold("Goal: ") + node.goal);
            log(chalk.dim(`Type: ${node.branch_type} | Mode: ${node.context_mode} | Status: ${node.status}`));
            break;
          }

          case "status": {
            const node = orchestrator.getActiveNode();
            log(JSON.stringify({
              id: node.id,
              branch_type: node.branch_type,
              context_mode: node.context_mode,
              status: node.status,
              goal: node.goal,
              message_count: node.messages.length,
              tokens: { input: node.input_tokens, output: node.output_tokens },
              parent_id: node.parent_id,
            }, null, 2));
            break;
          }

          case "export": {
            const id = args[0];
            const data = orchestrator.export(id);
            process.stdout.write(JSON.stringify(data, null, 2) + "\n");
            break;
          }

          case "nodes": {
            const nodes = orchestrator.getTreeData();
            nodes.forEach((n) => {
              const active = n.id === orchestrator.getActiveNode().id ? chalk.green(" ← active") : "";
              log(`${n.id.slice(0, 8)}  ${n.branch_type.padEnd(12)} ${n.status.padEnd(12)} ${n.goal}${active}`);
            });
            break;
          }

          case "quit":
          case "exit": {
            rl.close();
            process.exit(0);
          }

          default:
            err(`Unknown command: /${cmd}. Type /help for help.`);
        }

      // ── Chat turn ───────────────────────────────────────────────────────────
      } else {
        const response = await orchestrator.chat(input);
        log("\n" + chalk.bold("Assistant:") + "\n" + response + "\n");
      }

    } catch (e: any) {
      err(e.message ?? String(e));
    }

    prompt();
  });

  rl.on("close", () => {
    log(chalk.dim("\nBye."));
    process.exit(0);
  });
}

// ─── CLI Commands (outer shell) ───────────────────────────────────────────────

const program = new Command();

program
  .name("convotree")
  .description("Branching conversation tree manager")
  .version("0.1.0");

// convotree init <name> <goal>
program
  .command("init <name> <goal>")
  .description("Create a new conversation tree and enter REPL")
  .action(async (name: string, goal: string) => {
    const llm = requireLLM();
    const orch = createTree(db, llm, { name, goal });
    ok(`Created tree "${name}" [${orch.getTreeId().slice(0, 8)}]`);
    await startREPL(orch, name);
  });

// convotree open <tree-id>
program
  .command("open <treeId>")
  .description("Open an existing tree and enter REPL")
  .action(async (treeId: string) => {
    const llm = requireLLM();
    try {
      const orch = openTree(db, llm, treeId);
      await startREPL(orch, orch.getTreeName());
    } catch (e: any) {
      err(e.message ?? String(e));
      process.exit(1);
    }
  });

// convotree list
program
  .command("list")
  .description("List all trees")
  .action(() => {
    const trees = listTrees(db);
    if (!trees.length) { log("No trees yet. Run: convotree init <name> <goal>"); return; }
    trees.forEach((t) => {
      log(`${t.id.slice(0, 8)}  ${t.name.padEnd(20)} updated: ${t.updated_at.slice(0, 16)}`);
    });
  });

// convotree config [show|path|set|set-key]
const SETTABLE = ["provider", "model", "max_tokens", "fold_provider", "fold_model", "default_context_mode"];
const configCmd = program.command("config").description("View or edit ~/.convotree/config.json");

configCmd
  .command("show", { isDefault: true })
  .description("Show the active config (API keys redacted) and whether a key is set")
  .action(() => {
    const c = loadConfig();
    log(chalk.bold("\nconvotree config") + chalk.dim(`  (${CONFIG_FILE})\n`));
    log(`  provider:             ${c.provider}`);
    log(`  model:                ${c.model}`);
    log(`  max_tokens:           ${c.max_tokens}`);
    log(`  fold_provider:        ${c.fold_provider ?? chalk.dim("(falls back to provider)")}`);
    log(`  fold_model:           ${c.fold_model ?? chalk.dim("(falls back to model)")}`);
    log(`  default_context_mode: ${c.default_context_mode}`);
    log(`  db_path:              ${c.db_path}\n`);
    try {
      getApiKey(c);
      ok(`API key for "${c.provider}" is set`);
    } catch {
      err(`No API key for "${c.provider}"`);
      info(`Set one:  convotree config set-key <your-key>${c.provider !== "anthropic" ? ` --provider ${c.provider}` : ""}`);
    }
    log(chalk.dim(`\nbuilt-in providers: ${listProviders().join(", ")}`));
  });

configCmd
  .command("path")
  .description("Print the config file path")
  .action(() => log(CONFIG_FILE));

configCmd
  .command("set <field> <value>")
  .description(`Set a field (${SETTABLE.join(" | ")})`)
  .action((field: string, value: string) => {
    if (!SETTABLE.includes(field)) {
      err(`Unknown field "${field}". Settable: ${SETTABLE.join(", ")}`);
      process.exit(1);
    }
    let parsed: string | number = value;
    if (field === "max_tokens") {
      parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        err(`max_tokens must be a positive integer (got "${value}")`);
        process.exit(1);
      }
    }
    if (field === "default_context_mode" && value !== "summary" && value !== "full_context") {
      err(`default_context_mode must be "summary" or "full_context" (got "${value}")`);
      process.exit(1);
    }
    if (field === "provider" && !listProviders().includes(value)) {
      info(`Note: "${value}" isn't a built-in provider (${listProviders().join(", ")}); ensure it's registered.`);
    }
    const raw = readRawConfig();
    raw[field] = parsed;
    writeRawConfig(raw);
    ok(`Set ${field} = ${parsed}`);
  });

configCmd
  .command("set-key <key>")
  .option("-p, --provider <provider>", "provider to store the key for (default: current provider)")
  .description("Store an API key for a provider in the config file")
  .action((key: string, opts: { provider?: string }) => {
    const provider = opts.provider ?? loadConfig().provider;
    const raw = readRawConfig();
    raw.api_keys = { ...(raw.api_keys ?? {}), [provider]: key };
    writeRawConfig(raw);
    ok(`Stored API key for "${provider}".`);
    info(`Verify:  convotree config`);
  });

program.parse(process.argv);
