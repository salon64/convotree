// convotree — public library API.
//
//   import { createTree, Orchestrator, registerProvider } from "convotree";
//
// Importing this module also registers the built-in providers (anthropic, openai)
// via the side-effect import of ./llm/client.js below.

export * from "./models/types.js";

export { Orchestrator } from "./agents/orchestrator.js";
export { createTree, openTree } from "./session.js";
export type { CreateTreeOptions } from "./session.js";

// Side-effect import: registers the anthropic + openai built-ins before any
// consumer calls createLLMClient.
import "./llm/client.js";
export { registerProvider, createLLMClient, listProviders } from "./llm/registry.js";
export type { ProviderFactory } from "./llm/registry.js";

// Store + config access.
export { getDB, listTrees, getTree } from "./db/queries.js";
export { loadConfig, getApiKey } from "./config.js";
