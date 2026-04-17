# jarvis-plugin-memory

Persistent semantic memory for [JARVIS](https://github.com/ataide25/jarvis-app) — backed by ChromaDB, fully local, no API required.

## What it does

- Stores memories in a local ChromaDB vector database (`~/.jarvis/memory/`)
- Semantic search — find relevant memories by meaning, not just keywords
- Per-session and per-actor memory isolation via metadata
- Auto-injects recent context into the JARVIS system prompt on startup
- HUD panel with memory stats, type breakdown donut, source tracking, and activity counters
- Works for both JARVIS core and the actor pool

## Requirements

- Python 3.9+
- `chromadb` Python package

```bash
pip install chromadb
```

## Installation

```bash
# In JARVIS chat:
plugin_install github.com/giovanibarili/jarvis-plugin-memory
```

Or manually clone to `~/.jarvis/plugins/jarvis-plugin-memory` and add to your `settings.user.json`.

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across all memories |
| `memory_add` | Save a memory with metadata (type, source, importance, tags) |
| `memory_delete` | Delete a memory by ID |
| `memory_list` | List memories with filters (type, session, source) |
| `memory_stats` | Show storage stats and collection info |

## Memory Types

Use consistent types for better retrieval:

- `preference` — user preferences and likes
- `decision` — architecture or product decisions
- `code` — code patterns, snippets, solutions
- `fact` — general facts about the user, system, or projects
- `session_summary` — end-of-session summaries
- `task_result` — outcomes from actor tasks
- `conversation` — notable exchanges
- `error` — bugs and their fixes

## Storage

All data is stored locally at `~/.jarvis/memory/` (ChromaDB persistent format).
Override the path with the `JARVIS_MEMORY_DIR` environment variable.

Nothing leaves your machine.

## HUD Panel

The memory panel shows:
- **Status** (online/offline) and backend
- **Donut chart** — breakdown of memory types
- **Collections** — list with counts
- **Sources** — who saved memories (jarvis, actors...)
- **Activity counters** — searches and saves per session
- **Last save** — relative timestamp

## License

MIT
