// pieces/memory-piece.js
// JARVIS Memory Piece — persistent semantic memory via ChromaDB
// Manages the memory_server.py subprocess and exposes memory tools to JARVIS + actors.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class MemoryPiece {
  id = "memory";
  name = "Memory";

  constructor(ctx) {
    this.ctx = ctx;
    this.bus = null;
    this.proc = null;
    this.ready = false;
    this.pendingRequests = new Map(); // id → { resolve, reject }
    this.requestCounter = 0;
    this.wakeUpContext = "";
    this.stats = { total_memories: 0, collections: [] };
    this.metrics = { types: {}, sources: {}, lastSaved: null };
    this.searchCount = 0;
    this.addCount = 0;
    this.scriptPath = join(ctx.pluginDir, "scripts", "memory_server.py");
  }

  // ── Piece Lifecycle ─────────────────────────────────────────────────────────

  async start(bus) {
    this.bus = bus;

    if (!existsSync(this.scriptPath)) {
      this._log("warn", "memory_server.py not found at: " + this.scriptPath);
      return;
    }

    await this._startServer();
    this._registerTools();
    this._publishHud();

    // Load wake-up context asynchronously
    this._loadWakeUp().catch(() => {});
  }

  async stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.ready = false;
    this._removeHud();
  }

  systemContext(sessionId) {
    if (!this.ready) return "";
    const total = this.stats.total_memories ?? 0;
    if (total === 0) return "";

    let ctx = `## Memory System\nPersistent semantic memory active. ${total} memories stored locally in ChromaDB.\n`;
    if (this.wakeUpContext) {
      ctx += "\n" + this.wakeUpContext;
    }
    return ctx;
  }

  // ── Server Management ───────────────────────────────────────────────────────

  async _startServer() {
    return new Promise((resolve, reject) => {
      this._log("info", "Starting memory server...");

      this.proc = spawn("python3", [this.scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ANONYMIZED_TELEMETRY: "False",
          PYTHONWARNINGS: "ignore",
        },
      });

      const rl = createInterface({ input: this.proc.stdout });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);

          // First message is the ready signal
          if (msg.status === "ready") {
            this.ready = true;
            this._log("info", `Memory server ready. Dir: ${msg.memory_dir}`);
            resolve();
            return;
          }

          // Subsequent messages are RPC responses
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            if (msg.result?.error) {
              pending.reject(new Error(msg.result.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          this._log("warn", "Invalid JSON from server: " + line.slice(0, 100));
        }
      });

      this.proc.stderr.on("data", (data) => {
        // Suppress chromadb telemetry noise
        const text = data.toString();
        if (!text.includes("telemetry") && !text.includes("DeprecationWarning") && !text.includes("capture()")) {
          this._log("debug", "server stderr: " + text.slice(0, 200));
        }
      });

      this.proc.on("exit", (code) => {
        this.ready = false;
        this._log("warn", `Memory server exited with code ${code}`);
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("Memory server exited"));
        }
        this.pendingRequests.clear();
      });

      this.proc.on("error", (err) => {
        this._log("error", "Failed to start memory server: " + err.message);
        reject(err);
      });

      // Timeout if server doesn't start in 15s
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error("Memory server startup timeout"));
        }
      }, 15000);
    });
  }

  async _call(action, params = {}) {
    if (!this.ready || !this.proc) {
      throw new Error("Memory server not ready");
    }
    const id = String(++this.requestCounter);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const req = JSON.stringify({ id, action, params }) + "\n";
      this.proc.stdin.write(req);
      // Timeout per request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Memory request timeout: ${action}`));
        }
      }, 30000);
    });
  }

  async _loadWakeUp() {
    try {
      const result = await this._call("stats", {});
      this.stats = result;

      if (result.total_memories > 0) {
        const [wakeUp, metrics] = await Promise.all([
          this._call("wake_up", { limit: 8 }),
          this._call("metrics", {}),
        ]);
        this.wakeUpContext = wakeUp.context ?? "";
        this.metrics = metrics;
      }

      this._updateHud();
    } catch (e) {
      this._log("warn", "Wake-up load failed: " + e.message);
    }
  }

  async _refreshMetrics() {
    try {
      const [stats, metrics] = await Promise.all([
        this._call("stats", {}),
        this._call("metrics", {}),
      ]);
      this.stats = stats;
      this.metrics = metrics;
      this._updateHud();
    } catch (e) {
      // silent
    }
  }

  // ── Tool Registration ───────────────────────────────────────────────────────

  _registerTools() {
    const registry = this.ctx.capabilityRegistry;

    // memory_search
    registry.register({
      name: "memory_search",
      description: "Semantic search across persistent memory. Use before answering questions about past conversations, decisions, preferences, or any information that might have been saved previously.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — natural language description of what to find" },
          limit: { type: "number", description: "Max results to return (default: 5, max: 20)" },
          type: { type: "string", description: "Filter by memory type: preference, decision, code, fact, session_summary, task_result, conversation" },
          session: { type: "string", description: "Filter by session ID (e.g. 'main', 'actor-researcher')" },
          source: { type: "string", description: "Filter by source (e.g. 'jarvis', actor name)" },
          collection: { type: "string", description: "Collection name (default: jarvis_memory)" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        try {
          const result = await this._call("search", {
            query: input.query,
            limit: input.limit ?? 5,
            type: input.type,
            session: input.session,
            source: input.source,
            collection: input.collection ?? "jarvis_memory",
          });
          this.searchCount++;
          this._updateHud();
          return result;
        } catch (e) {
          return { error: e.message, results: [] };
        }
      },
    });

    // memory_add
    registry.register({
      name: "memory_add",
      description: "Save information to persistent memory. Use for important facts, decisions, preferences, code patterns, task outcomes, and session summaries. Information persists across restarts.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to store — be specific and include context" },
          type: { type: "string", description: "Memory type: preference, decision, code, fact, session_summary, task_result, conversation, error" },
          source: { type: "string", description: "Who is saving this (e.g. 'jarvis', 'actor-researcher')" },
          session: { type: "string", description: "Session ID this memory is from" },
          importance: { type: "string", description: "Memory importance: low, medium, high, critical" },
          project: { type: "string", description: "Project name if relevant" },
          tags: { type: "array", items: { type: "string" }, description: "List of tags for categorization" },
          collection: { type: "string", description: "Collection name (default: jarvis_memory)" },
          id: { type: "string", description: "Custom ID — if provided, updates existing memory with same ID" },
        },
        required: ["content"],
      },
      handler: async (input) => {
        // Determine source from session ID if not provided
        const sessionId = input.__sessionId;
        const source = input.source ?? (sessionId?.startsWith("actor-") ? sessionId.replace("actor-", "") : "jarvis");

        try {
          const result = await this._call("add", {
            content: input.content,
            type: input.type ?? "fact",
            source,
            session: input.session ?? sessionId ?? "main",
            importance: input.importance ?? "medium",
            project: input.project,
            tags: input.tags,
            collection: input.collection ?? "jarvis_memory",
            id: input.id,
          });

          // Refresh stats + metrics after adding
          this.addCount++;
          this._refreshMetrics().catch(() => {});

          return result;
        } catch (e) {
          return { error: e.message };
        }
      },
    });

    // memory_delete
    registry.register({
      name: "memory_delete",
      description: "Delete a memory by ID. Use to remove outdated or incorrect memories.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID to delete" },
          collection: { type: "string", description: "Collection name (default: jarvis_memory)" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        try {
          return await this._call("delete", {
            id: input.id,
            collection: input.collection ?? "jarvis_memory",
          });
        } catch (e) {
          return { error: e.message };
        }
      },
    });

    // memory_list
    registry.register({
      name: "memory_list",
      description: "List memories with optional filters. Use to browse what's stored or find memories by metadata.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default: 20)" },
          offset: { type: "number", description: "Pagination offset" },
          type: { type: "string", description: "Filter by type" },
          session: { type: "string", description: "Filter by session" },
          source: { type: "string", description: "Filter by source" },
          collection: { type: "string", description: "Collection name (default: jarvis_memory)" },
        },
        required: [],
      },
      handler: async (input) => {
        try {
          return await this._call("list", {
            limit: input.limit ?? 20,
            offset: input.offset ?? 0,
            type: input.type,
            session: input.session,
            source: input.source,
            collection: input.collection ?? "jarvis_memory",
          });
        } catch (e) {
          return { error: e.message, items: [] };
        }
      },
    });

    // memory_stats
    registry.register({
      name: "memory_stats",
      description: "Show memory system status — total memories, collections, storage location.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          const result = await this._call("stats", {});
          this.stats = result;
          this._updateHud();
          return result;
        } catch (e) {
          return { error: e.message };
        }
      },
    });
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────

  _publishHud() {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "indicator",
        name: "Memory",
        status: "running",
        data: this._getHudData(),
        position: { x: 10, y: 160 },
        size: { width: 220, height: 310 },
      },
    });
  }

  _updateHud() {
    if (!this.bus) return;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this._getHudData(),
      status: this.ready ? "running" : "stopped",
    });
  }

  _removeHud() {
    if (!this.bus) return;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
  }

  _getHudData() {
    return {
      total: this.stats.total_memories ?? 0,
      collections: this.stats.collections ?? [],
      ready: this.ready,
      recentTypes: this.metrics.types ?? {},
      recentSources: this.metrics.sources ?? {},
      lastSaved: this.metrics.lastSaved ?? null,
      searchCount: this.searchCount,
      addCount: this.addCount,
    };
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  _log(level, msg) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const prefix = `[MemoryPiece]`;
    if (level === "error") console.error(prefix, msg);
    else if (level === "warn") console.warn(prefix, msg);
    else console.log(prefix, msg);
  }
}
