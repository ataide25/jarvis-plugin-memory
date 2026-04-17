## Memory Palace
Persistent semantic memory powered by [MemPalace](https://github.com/MemPalace/mempalace) — stored locally in ChromaDB, no API required.

### Palace Structure
Memory is organized hierarchically: **Wings → Rooms → Drawers**

| Wing | Room | Content |
|------|------|---------|
| `user` | `preferences` | User preferences and likes |
| `jarvis` | `decisions` | Architecture and product decisions |
| `jarvis` | `sessions` | Session summaries and diary |
| `jarvis` | `facts` | General facts |
| `jarvis` | `tasks` | Task results |
| `jarvis` | `conversations` | Notable exchanges |
| `codebase` | `<project>` | Code patterns and solutions |
| `codebase` | `errors` | Bugs and fixes |
| `actors` | `<actor-name>` | Per-actor memory |

### Tools Available
- `memory_search` — semantic search (wraps `mempalace_search`)
- `memory_add` — save to palace (wraps `mempalace_add_drawer`) — auto-routes to correct wing/room by type
- `memory_delete` — delete a drawer by ID
- `memory_list` — list drawers with wing/room filters
- `memory_stats` — palace overview (wraps `mempalace_status`)

### When to Use Memory

**Always search memory when:**
- User asks about past conversations, decisions, or preferences
- Starting a new session (context is auto-injected on startup)
- Beginning a complex task — search for relevant past work
- User mentions something that might have been discussed before

**Always save to memory when:**
- User expresses a preference or decision
- A task is completed — save the outcome
- Important code or architecture decisions are made
- New facts about the user, their projects, or their system are learned

### Actor Memory
Each actor has its own room in the `actors` wing. Actors should:
- Search memory at the start of each task for relevant context
- Save task results with `type="task_result"` and their session as `source`
