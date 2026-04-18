// pieces/memory-piece.js
// JARVIS Memory Piece — wrapper around MemPalace MCP server (https://github.com/MemPalace/mempalace)
// Spawns the MemPalace MCP subprocess, bridges its JSON-RPC protocol to JARVIS capability tools,
// injects wake-up context into the system prompt, and drives the HUD panel.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const PALACE_DIR = process.env.JARVIS_PALACE_DIR ?? join(homedir(), ".jarvis", "palace");

export class MemoryPiece {
  id = "memory";
  name = "Memory";

  constructor(ctx) {
    this.ctx = ctx;
    this.bus = null;
    this.proc = null;
    this.ready = false;
    this.initialized = false;

    // JSON-RPC state
    this.rpcCounter = 0;
    this.pending = new Map(); // id → { resolve, reject }
    this.buffer = "";

    // HUD data
    this.wakeUpContext = "";
    this.stats = { total_memories: 0, collections: [] };
    this.metrics = { types: {}, sources: {}, lastSaved: null };
    this.searchCount = 0;
    this.addCount = 0;

    // Tool schema cache
    this.toolSchemas = new Map();

    // Auto-save state
    this.lastActivityAt = Date.now();
    this.idleTimer = null;
    this.IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    this.lastCompactionSavedAt = null;
    this.sessionMessageCount = 0;
  }

  // ── Piece Lifecycle ─────────────────────────────────────────────────────────

  async start(bus) {
    this.bus = bus;

    // Ensure palace dir exists
    if (!existsSync(PALACE_DIR)) {
      mkdirSync(PALACE_DIR, { recursive: true });
    }

    try {
      await this._startMcpServer();
      await this._mcpInitialize();
      await this._loadToolSchemas();
      this._registerTools();
      this._publishHud();
      this._loadWakeUp().catch(() => {});
      this._subscribeToEvents();
    } catch (e) {
      this._log("error", "Failed to start MemPalace: " + e.message);
      this._publishHud();
    }
  }

  async stop() {
    this._clearIdleTimer();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.ready = false;
    this._removeHud();
  }

  // ── Event Subscriptions ─────────────────────────────────────────────────────

  _subscribeToEvents() {
    // 1. Listen for compaction via ai.stream — carries the full summary
    this.bus.subscribe("ai.stream", async (msg) => {
      // 1a. Compaction event → auto-save summary to palace
      if (msg.event === "compaction" && msg.target === "main") {
        await this._onCompaction(msg.compaction);
      }

      // 1b. Complete event → track activity + reset idle timer
      if (msg.event === "complete" && msg.target === "main") {
        this.lastActivityAt = Date.now();
        this.sessionMessageCount++;
        this._resetIdleTimer();
      }
    });

    // 2. Listen for ai.request → reset idle timer on new user messages
    this.bus.subscribe("ai.request", (msg) => {
      if (msg.target === "main") {
        this.lastActivityAt = Date.now();
        this._resetIdleTimer();
      }
    });

    this._log("info", "Subscribed to ai.stream (compaction + complete) and ai.request");
  }

  // ── Auto-save: Post-Compaction ───────────────────────────────────────────────

  async _onCompaction(compaction) {
    if (!this.ready || !compaction) return;

    // Debounce: don't save twice within 60s for the same compaction event
    const now = Date.now();
    if (this.lastCompactionSavedAt && now - this.lastCompactionSavedAt < 60_000) return;
    this.lastCompactionSavedAt = now;

    this._log("info", `Compaction (${compaction.engine}) — auto-saving summary to palace`);

    try {
      const ts = new Date().toISOString().slice(0, 10);
      const summary = compaction.summary
        ? String(compaction.summary).slice(0, 2000)
        : "(no summary available)";

      const content = [
        `[auto] Session compaction summary [${ts}]`,
        `Engine: ${compaction.engine} | Context: ${compaction.tokensBefore ?? "?"}tok → ${compaction.tokensAfter ?? "?"}tok`,
        `Messages in session: ~${this.sessionMessageCount}`,
        ``,
        summary,
      ].join("\n");

      await this._callTool("mempalace_add_drawer", {
        content,
        wing: "jarvis",
        room: "sessions",
        added_by: "jarvis-auto",
      });

      this.addCount++;
      this._refreshStats().catch(() => {});
      this._log("info", "Compaction summary saved to palace");
    } catch (e) {
      this._log("warn", "Failed to save compaction summary: " + e.message);
    }
  }

  // ── Auto-save: Idle / Inactivity ─────────────────────────────────────────────

  _resetIdleTimer() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => this._onIdle(), this.IDLE_TIMEOUT_MS);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async _onIdle() {
    if (!this.ready || this.sessionMessageCount === 0) return;

    this._log("info", `Idle for ${this.IDLE_TIMEOUT_MS / 60000}min — auto-saving session snapshot`);

    try {
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      const content = [
        `Session idle snapshot [${ts}]`,
        `Messages exchanged: ~${this.sessionMessageCount}`,
        `Last activity: ${new Date(this.lastActivityAt).toISOString()}`,
        `Memories in palace: ${this.stats.total_memories ?? 0}`,
      ].join("\n");

      await this._callTool("mempalace_add_drawer", {
        content,
        wing: "jarvis",
        room: "sessions",
        added_by: "jarvis-auto",
      });

      this.addCount++;
      this._refreshStats().catch(() => {});
      this._log("info", "Idle session snapshot saved to palace");
    } catch (e) {
      this._log("warn", "Failed to save idle snapshot: " + e.message);
    }
  }

  systemContext(sessionId) {
    if (!this.ready) return "";

    const total = this.stats.total_memories ?? 0;
    const palaceDir = PALACE_DIR;

    let ctx = `## Memory Palace\nPersistent semantic memory active. ${total} memories stored locally in MemPalace (ChromaDB).\n`;
    ctx += `Palace: ${palaceDir}\n`;

    if (this.wakeUpContext) {
      ctx += "\n" + this.wakeUpContext;
    }

    return ctx;
  }

  // ── MCP Server ──────────────────────────────────────────────────────────────

  async _startMcpServer() {
    return new Promise((resolve, reject) => {
      this._log("info", `Starting MemPalace MCP server — palace: ${PALACE_DIR}`);

      this.proc = spawn("python3", ["-m", "mempalace.mcp_server", "--palace", PALACE_DIR], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ANONYMIZED_TELEMETRY: "False",
          PYTHONWARNINGS: "ignore",
        },
      });

      // MemPalace MCP uses newline-delimited JSON (stdio transport)
      const rl = createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => this._onMcpLine(line));

      this.proc.stderr.on("data", (data) => {
        const text = data.toString();
        // Suppress telemetry noise
        if (!text.includes("telemetry") && !text.includes("capture()") && !text.includes("DeprecationWarning")) {
          this._log("debug", "stderr: " + text.slice(0, 200).trim());
        }
      });

      this.proc.on("exit", (code) => {
        this.ready = false;
        this._log("warn", `MemPalace exited: ${code}`);
        for (const [, p] of this.pending) p.reject(new Error("MemPalace server exited"));
        this.pending.clear();
        this._updateHud();
      });

      this.proc.on("error", (err) => reject(err));

      // The process is ready when it starts (no explicit ready signal in MCP stdio)
      setTimeout(() => resolve(), 800);
    });
  }

  _onMcpLine(line) {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      if (id !== undefined && this.pending.has(id)) {
        const { resolve, reject } = this.pending.get(id);
        this.pending.delete(id);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else resolve(msg.result ?? {});
      }
    } catch (e) {
      this._log("debug", "Non-JSON line: " + line.slice(0, 100));
    }
  }

  _rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("MemPalace not running"));
      const id = ++this.rpcCounter;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async _mcpInitialize() {
    await this._rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jarvis", version: "1.0" },
    });
    // Send initialized notification
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    this.initialized = true;
    this.ready = true;
    this._log("info", "MemPalace MCP initialized");
  }

  async _loadToolSchemas() {
    const result = await this._rpc("tools/list", {});
    for (const tool of result.tools ?? []) {
      this.toolSchemas.set(tool.name, tool);
    }
    this._log("info", `Loaded ${this.toolSchemas.size} MemPalace tools`);
  }

  async _callTool(name, args = {}) {
    const result = await this._rpc("tools/call", { name, arguments: args });
    // MCP tool results are in result.content[0].text (text blocks)
    const content = result.content ?? [];
    const text = content.map(c => c.text ?? "").join("\n").trim();
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  // ── Tool Registration ───────────────────────────────────────────────────────
  // Expose a curated set of MemPalace tools directly in JARVIS CapabilityRegistry
  // with JARVIS-friendly names and descriptions.

  _registerTools() {
    const registry = this.ctx.capabilityRegistry;

    // ── memory_search → mempalace_search ─────────────────────────────────────
    registry.register({
      name: "memory_search",
      description: "Semantic search across persistent memory (MemPalace). Use before answering questions about past conversations, decisions, preferences, or any information that might have been saved previously.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 5)" },
          wing: { type: "string", description: "Filter by wing (e.g. 'jarvis', 'user', 'codebase')" },
          room: { type: "string", description: "Filter by room within a wing" },
          collection: { type: "string", description: "Ignored — kept for API compatibility" },
          session: { type: "string", description: "Ignored — use wing/room for filtering" },
          source: { type: "string", description: "Ignored — use wing/room for filtering" },
          type: { type: "string", description: "Ignored — use wing/room for filtering" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        try {
          const args = { query: String(input.query), limit: Number(input.limit ?? 5) };
          if (input.wing) args.wing = input.wing;
          if (input.room) args.room = input.room;
          const result = await this._callTool("mempalace_search", args);
          this.searchCount++;
          this._updateHud();
          return result;
        } catch (e) {
          return { error: e.message, results: [] };
        }
      },
    });

    // ── memory_add → mempalace_add_drawer ────────────────────────────────────
    registry.register({
      name: "memory_add",
      description: "Save information to persistent memory (MemPalace). Use for important facts, decisions, preferences, code patterns, task outcomes, and session summaries.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to store — be specific and include context" },
          type: { type: "string", description: "Memory type: preference, decision, code, fact, session_summary, task_result, conversation, error" },
          source: { type: "string", description: "Who is saving this (e.g. 'jarvis', 'actor-researcher')" },
          session: { type: "string", description: "Session ID this memory is from" },
          importance: { type: "string", description: "Memory importance: low, medium, high, critical" },
          project: { type: "string", description: "Project name if relevant" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
          collection: { type: "string", description: "Ignored — kept for API compatibility" },
          id: { type: "string", description: "Ignored — MemPalace manages IDs internally" },
        },
        required: ["content"],
      },
      handler: async (input) => {
        try {
          const sessionId = input.__sessionId ?? "main";
          const source = input.source ?? (sessionId.startsWith("actor-") ? sessionId : "jarvis");
          const type = input.type ?? "fact";

          // Map JARVIS memory types to MemPalace wing/room structure
          const { wing, room } = this._typeToWingRoom(type, source, input.project);

          const args = {
            content: String(input.content),
            wing,
            room,
            added_by: source,
          };

          const result = await this._callTool("mempalace_add_drawer", args);
          this.addCount++;
          this._refreshStats().catch(() => {});
          return result;
        } catch (e) {
          return { error: e.message };
        }
      },
    });

    // ── memory_delete → mempalace_delete_drawer ──────────────────────────────
    registry.register({
      name: "memory_delete",
      description: "Delete a memory by ID. Use to remove outdated or incorrect memories.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory/drawer ID to delete" },
          collection: { type: "string", description: "Ignored" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        try {
          return await this._callTool("mempalace_delete_drawer", { drawer_id: String(input.id) });
        } catch (e) {
          return { error: e.message };
        }
      },
    });

    // ── memory_list → mempalace_list_drawers ─────────────────────────────────
    registry.register({
      name: "memory_list",
      description: "List memories with optional filters. Use to browse what's stored or find memories by metadata.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default: 20)" },
          offset: { type: "number", description: "Pagination offset" },
          wing: { type: "string", description: "Filter by wing" },
          room: { type: "string", description: "Filter by room" },
          type: { type: "string", description: "Ignored — use wing/room" },
          session: { type: "string", description: "Ignored — use wing/room" },
          source: { type: "string", description: "Ignored — use wing/room" },
          collection: { type: "string", description: "Ignored" },
        },
        required: [],
      },
      handler: async (input) => {
        try {
          const args = { limit: Number(input.limit ?? 20) };
          if (input.wing) args.wing = input.wing;
          if (input.room) args.room = input.room;
          return await this._callTool("mempalace_list_drawers", args);
        } catch (e) {
          return { error: e.message, items: [] };
        }
      },
    });

    // ── memory_stats → mempalace_status ──────────────────────────────────────
    registry.register({
      name: "memory_stats",
      description: "Show memory system status — total drawers, wings, rooms, palace location.",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        try {
          const result = await this._callTool("mempalace_status", {});
          await this._refreshStats();
          return result;
        } catch (e) {
          return { error: e.message };
        }
      },
    });
  }

  // ── Wing/Room Mapping ───────────────────────────────────────────────────────
  // Maps JARVIS memory types to MemPalace hierarchical structure

  _typeToWingRoom(type, source, project) {
    // Actor sources go to their own wing
    if (source && source.startsWith("actor-")) {
      const actorName = source.replace("actor-", "");
      return { wing: "actors", room: actorName };
    }

    const map = {
      preference:      { wing: "user",     room: "preferences" },
      decision:        { wing: "jarvis",   room: "decisions" },
      code:            { wing: "codebase", room: project ?? "general" },
      fact:            { wing: "jarvis",   room: "facts" },
      session_summary: { wing: "jarvis",   room: "sessions" },
      task_result:     { wing: "jarvis",   room: "tasks" },
      conversation:    { wing: "jarvis",   room: "conversations" },
      error:           { wing: "codebase", room: "errors" },
    };

    return map[type] ?? { wing: "jarvis", room: "general" };
  }

  // ── Stats & Wake-up ─────────────────────────────────────────────────────────

  async _loadWakeUp() {
    try {
      // Get palace status for HUD
      const status = await this._callTool("mempalace_status", {});
      this.stats.total_memories = status.total_drawers ?? 0;
      this.stats.collections = [];

      // Get taxonomy for type breakdown
      const taxonomy = await this._callTool("mempalace_get_taxonomy", {});
      this._buildMetricsFromTaxonomy(taxonomy);

      // Wake-up context: recent diary entries + quick status
      if (this.stats.total_memories > 0) {
        try {
          const diary = await this._callTool("mempalace_diary_read", { limit: 5 });
          const search = await this._callTool("mempalace_search", { query: "recent context session summary", limit: 5 });
          this.wakeUpContext = this._buildWakeUpContext(status, diary, search);
        } catch { /* diary might be empty */ }
      }

      this._updateHud();
    } catch (e) {
      this._log("warn", "Wake-up failed: " + e.message);
    }
  }

  async _refreshStats() {
    try {
      const status = await this._callTool("mempalace_status", {});
      this.stats.total_memories = status.total_drawers ?? 0;
      const taxonomy = await this._callTool("mempalace_get_taxonomy", {});
      this._buildMetricsFromTaxonomy(taxonomy);
      this._updateHud();
    } catch { /* silent */ }
  }

  _buildMetricsFromTaxonomy(taxonomy) {
    // taxonomy shape: { wings: { wing_name: { rooms: { room_name: count } } } }
    const types = {};
    const sources = {};

    if (taxonomy?.wings) {
      for (const [wing, wingData] of Object.entries(taxonomy.wings)) {
        const rooms = wingData?.rooms ?? {};
        for (const [room, count] of Object.entries(rooms)) {
          // Reverse-map wing/room back to a "type" label for the HUD
          const label = this._wingRoomToLabel(wing, room);
          types[label] = (types[label] ?? 0) + (count ?? 0);
          sources[wing] = (sources[wing] ?? 0) + (count ?? 0);
        }
      }
    }

    this.metrics = { types, sources, lastSaved: new Date().toISOString() };
  }

  _wingRoomToLabel(wing, room) {
    if (wing === "user") return "preference";
    if (wing === "actors") return "task_result";
    if (wing === "codebase" && room === "errors") return "error";
    if (wing === "codebase") return "code";
    if (room === "decisions") return "decision";
    if (room === "sessions") return "session_summary";
    if (room === "tasks") return "task_result";
    if (room === "conversations") return "conversation";
    return "fact";
  }

  _buildWakeUpContext(status, diary, search) {
    const lines = [];
    lines.push(`## Memory Palace — ${status.total_drawers ?? 0} drawers, ${status.wing_count ?? 0} wings`);

    if (diary?.entries?.length > 0) {
      lines.push("\n### Recent Diary");
      for (const entry of diary.entries.slice(0, 3)) {
        lines.push(`- ${entry.content?.slice(0, 200) ?? ""}`);
      }
    }

    if (search?.results?.length > 0) {
      lines.push("\n### Relevant Context");
      for (const r of search.results.slice(0, 3)) {
        lines.push(`- [${r.wing ?? "?"}/${r.room ?? "?"}] ${r.content?.slice(0, 200) ?? ""}`);
      }
    }

    return lines.join("\n");
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
        position: { x: 240, y: 110 },
        size: { width: 240, height: 320 },
        renderer: { plugin: "jarvis-plugin-memory", file: "MemoryRenderer" },
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
      backend: "mempalace",
      palaceDir: PALACE_DIR,
    };
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  _log(level, msg) {
    const prefix = "[MemoryPiece]";
    if (level === "error") console.error(prefix, msg);
    else if (level === "warn") console.warn(prefix, msg);
    else if (level !== "debug") console.log(prefix, msg);
  }
}
