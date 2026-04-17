# jarvis-plugin-memory

Persistent semantic memory for [JARVIS](https://github.com/giovanibarili/jarvis-app) — powered by [MemPalace](https://github.com/MemPalace/mempalace), fully local, no API required.

This plugin is a JARVIS wrapper around MemPalace. It spawns the MemPalace MCP server internally, bridges its tools into the JARVIS capability registry with familiar names (`memory_search`, `memory_add`, etc.), injects wake-up context into the system prompt, and renders a live HUD panel.

## Architecture

```
JARVIS Core / Actor Pool
        │
        ▼
 jarvis-plugin-memory
  ├── memory_search  ──▶  mempalace_search
  ├── memory_add     ──▶  mempalace_add_drawer  (auto wing/room routing)
  ├── memory_delete  ──▶  mempalace_delete_drawer
  ├── memory_list    ──▶  mempalace_list_drawers
  └── memory_stats   ──▶  mempalace_status
        │
        ▼
  MemPalace MCP Server (stdio subprocess)
        │
        ▼
  ChromaDB + SQLite (~/.jarvis/palace/)
```

## Requirements

- Python 3.9+
- `mempalace` Python package

```bash
pip install mempalace
```

> **Note:** chromadb is installed automatically as a mempalace dependency.

---

## Installation

### Option A — Via JARVIS chat (recommended)

```
plugin_install github.com/ataide25/jarvis-plugin-memory
```

### Option B — Manual

```bash
git clone https://github.com/ataide25/jarvis-plugin-memory ~/.jarvis/plugins/jarvis-plugin-memory
```

Add to `~/.jarvis/settings.user.json`:

```json
{
  "plugins": {
    "jarvis-plugin-memory": {
      "enabled": true,
      "path": "~/.jarvis/plugins/jarvis-plugin-memory",
      "repo": "https://github.com/ataide25/jarvis-plugin-memory"
    }
  }
}
```

Restart JARVIS.

---

## Palace Setup

The palace is initialized automatically at `~/.jarvis/palace/` on first use.

To override the location:

```bash
export JARVIS_PALACE_DIR=/custom/path/to/palace
```

---

## Memory Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search — find memories by meaning |
| `memory_add` | Save a memory — auto-routed to the correct wing/room by type |
| `memory_delete` | Delete a memory by drawer ID |
| `memory_list` | List memories with wing/room filters |
| `memory_stats` | Palace overview — total drawers, wings, rooms |

### Palace Structure

Memory is organized as **Wings → Rooms → Drawers**:

| Wing | Room | Memory type |
|------|------|-------------|
| `user` | `preferences` | Preferences |
| `jarvis` | `decisions` | Architecture decisions |
| `jarvis` | `sessions` | Session summaries |
| `jarvis` | `facts` | General facts |
| `jarvis` | `tasks` | Task results |
| `jarvis` | `conversations` | Notable exchanges |
| `codebase` | `<project>` | Code patterns |
| `codebase` | `errors` | Bugs and fixes |
| `actors` | `<actor-name>` | Per-actor memory |

### Example usage

```
# Save a preference
memory_add content="User prefers concise responses" type="preference" importance="high"

# Save a decision
memory_add content="Chose ChromaDB over Pinecone — local-first, no API key" type="decision" project="jarvis"

# Save a task result from an actor
memory_add content="Refactored auth module to JWT" type="task_result" source="actor-coder"

# Search
memory_search query="architecture decisions about database"

# Browse recent memories
memory_list wing="jarvis" room="decisions"
```

---

## HUD Panel

The memory panel shows:
- **Status** — online/offline, backend: mempalace
- **Donut chart** — breakdown of memory types with percentages
- **Collections/Wings** — with drawer counts
- **Sources** — who saved memories (jarvis, actor names...)
- **Activity counters** — searches and saves per session
- **Last save** — relative timestamp

---

## Storage

All data lives at `~/.jarvis/palace/` (ChromaDB + SQLite, fully local).

Nothing leaves your machine.

---

## License

MIT
