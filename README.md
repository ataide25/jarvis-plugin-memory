# jarvis-plugin-memory

Persistent semantic memory for [JARVIS](https://github.com/giovanibarili/jarvis-app) — backed by ChromaDB, fully local, no API required.

## What it does

- Stores memories in a local ChromaDB vector database (`~/.jarvis/memory/`)
- Semantic search — find relevant memories by meaning, not just keywords
- Per-session and per-actor memory isolation via metadata
- Auto-injects recent context into the JARVIS system prompt on startup
- HUD panel with memory stats, type breakdown donut, source tracking, and activity counters
- Works for both JARVIS core and the actor pool

---

## Requirements

- Python 3.9+
- `chromadb` Python package

```bash
pip install chromadb
```

> **Note:** This plugin does NOT require MemPalace. It talks directly to ChromaDB.  
> If you want to also use MemPalace for advanced memory features (knowledge graph, palace structure, MCP tools), see [Optional: MemPalace](#optional-mempalace) below.

---

## Installation

### Option A — Via JARVIS chat (recommended)

```
plugin_install github.com/ataide25/jarvis-plugin-memory
```

JARVIS will clone the repo to `~/.jarvis/plugins/jarvis-plugin-memory` and load it automatically.

### Option B — Manual

```bash
# 1. Clone the plugin
git clone https://github.com/ataide25/jarvis-plugin-memory ~/.jarvis/plugins/jarvis-plugin-memory

# 2. Add to ~/.jarvis/settings.user.json
```

```json
{
  "plugins": {
    "jarvis-plugin-memory": {
      "enabled": true,
      "path": "/Users/YOUR_USER/.jarvis/plugins/jarvis-plugin-memory",
      "repo": "https://github.com/ataide25/jarvis-plugin-memory"
    }
  }
}
```

```bash
# 3. Restart JARVIS
```

---

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across all memories |
| `memory_add` | Save a memory with metadata (type, source, importance, tags) |
| `memory_delete` | Delete a memory by ID |
| `memory_list` | List memories with filters (type, session, source) |
| `memory_stats` | Show storage stats and collection info |

### Example usage

```
# Search for past decisions
memory_search query="architecture decisions" type="decision"

# Save a preference
memory_add content="User prefers concise responses" type="preference" importance="high"

# Save a task result
memory_add content="Refactored the auth module — moved to JWT" type="task_result" project="myapp"

# List recent memories
memory_list limit=10 type="decision"
```

---

## Memory Types

Use consistent types for better retrieval:

| Type | Description |
|------|-------------|
| `preference` | User preferences and likes |
| `decision` | Architecture or product decisions |
| `code` | Code patterns, snippets, solutions |
| `fact` | General facts about the user, system, or projects |
| `session_summary` | End-of-session summaries |
| `task_result` | Outcomes from actor tasks |
| `conversation` | Notable exchanges |
| `error` | Bugs and their fixes |

---

## HUD Panel

The memory panel shows:
- **Status** — online/offline indicator and backend name
- **Donut chart** — visual breakdown of memory types with percentages
- **Collections** — list with memory counts
- **Sources** — who saved memories (jarvis, actor names...)
- **Activity counters** — searches and saves per session
- **Last save** — relative timestamp of most recent memory

---

## Storage

All data is stored locally at `~/.jarvis/memory/` (ChromaDB persistent format).

Override the path with the `JARVIS_MEMORY_DIR` environment variable:

```bash
export JARVIS_MEMORY_DIR=/custom/path/to/memory
```

Nothing leaves your machine.

---

## Optional: MemPalace

This plugin uses ChromaDB directly and is fully self-contained.

If you want **advanced memory features** — hierarchical structure (Wings → Rooms → Drawers), knowledge graph, 29 MCP tools, and 96.6% recall benchmarks — you can additionally install [MemPalace](https://github.com/MemPalace/mempalace):

```bash
pip install mempalace
mempalace init ~/.mempalace/palace
```

Then add it as an MCP server in `~/.jarvis/mcp.json`:

```json
{
  "mempalace": {
    "type": "stdio",
    "command": "python3",
    "args": ["-m", "mempalace.mcp_server", "--palace", "/Users/YOUR_USER/.mempalace/palace"],
    "autoConnect": true
  }
}
```

> MemPalace is independent of this plugin — both can run simultaneously.

---

## License

MIT
