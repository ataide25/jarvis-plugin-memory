#!/usr/bin/env python3
"""
JARVIS Memory Server — ChromaDB-backed persistent semantic memory.
Runs as a subprocess, communicates via stdin/stdout JSON-RPC style.
"""
import sys
import json
import os
import traceback
from pathlib import Path
from datetime import datetime

# Suppress chromadb telemetry noise
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

try:
    import chromadb
    from chromadb.config import Settings
except ImportError:
    print(json.dumps({"error": "chromadb not installed. Run: pip install chromadb"}), flush=True)
    sys.exit(1)

# ── Setup ──────────────────────────────────────────────────────────────────────

MEMORY_DIR = Path(os.environ.get("JARVIS_MEMORY_DIR", Path.home() / ".jarvis" / "memory"))
MEMORY_DIR.mkdir(parents=True, exist_ok=True)

def get_client():
    return chromadb.PersistentClient(
        path=str(MEMORY_DIR),
        settings=Settings(anonymized_telemetry=False)
    )

def get_collection(client, name: str):
    """Get or create a named collection with cosine distance."""
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"}
    )

# ── Handlers ───────────────────────────────────────────────────────────────────

def handle_add(params: dict) -> dict:
    client = get_client()
    collection_name = params.get("collection", "jarvis_memory")
    col = get_collection(client, collection_name)

    content = params.get("content", "")
    if not content.strip():
        return {"error": "content is required"}

    import hashlib
    doc_id = params.get("id") or hashlib.sha256(content.encode()).hexdigest()[:16]

    # Build metadata
    metadata = {
        "timestamp": datetime.utcnow().isoformat(),
        "type": params.get("type", "fact"),
        "source": params.get("source", "jarvis"),
        "session": params.get("session", "main"),
        "importance": params.get("importance", "medium"),
    }
    if params.get("project"):
        metadata["project"] = params["project"]
    if params.get("tags"):
        tags = params["tags"]
        metadata["tags"] = json.dumps(tags) if isinstance(tags, list) else str(tags)

    # Check for duplicate
    try:
        existing = col.get(ids=[doc_id])
        if existing["ids"]:
            # Update existing
            col.update(ids=[doc_id], documents=[content], metadatas=[metadata])
            return {"ok": True, "id": doc_id, "action": "updated"}
    except Exception:
        pass

    col.add(ids=[doc_id], documents=[content], metadatas=[metadata])
    return {"ok": True, "id": doc_id, "action": "added"}


def handle_search(params: dict) -> dict:
    client = get_client()
    collection_name = params.get("collection", "jarvis_memory")

    try:
        col = get_collection(client, collection_name)
    except Exception as e:
        return {"results": [], "count": 0}

    query = params.get("query", "")
    if not query.strip():
        return {"error": "query is required"}

    n_results = min(int(params.get("limit", 5)), 20)

    # Build where filter
    where = {}
    if params.get("type"):
        where["type"] = {"$eq": params["type"]}
    if params.get("session"):
        where["session"] = {"$eq": params["session"]}
    if params.get("source"):
        where["source"] = {"$eq": params["source"]}
    if params.get("importance"):
        where["importance"] = {"$eq": params["importance"]}

    try:
        count = col.count()
        if count == 0:
            return {"results": [], "count": 0}

        n_results = min(n_results, count)

        query_kwargs = {
            "query_texts": [query],
            "n_results": n_results,
            "include": ["documents", "metadatas", "distances"]
        }
        if where:
            query_kwargs["where"] = where

        results = col.query(**query_kwargs)

        formatted = []
        for i, doc_id in enumerate(results["ids"][0]):
            formatted.append({
                "id": doc_id,
                "content": results["documents"][0][i],
                "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                "relevance": round(1 - results["distances"][0][i], 4),
            })

        return {"results": formatted, "count": len(formatted)}
    except Exception as e:
        return {"error": str(e), "results": [], "count": 0}


def handle_delete(params: dict) -> dict:
    client = get_client()
    collection_name = params.get("collection", "jarvis_memory")

    try:
        col = get_collection(client, collection_name)
    except Exception:
        return {"error": "collection not found"}

    doc_id = params.get("id")
    if not doc_id:
        return {"error": "id is required"}

    col.delete(ids=[doc_id])
    return {"ok": True, "id": doc_id}


def handle_list(params: dict) -> dict:
    client = get_client()
    collection_name = params.get("collection", "jarvis_memory")

    try:
        col = get_collection(client, collection_name)
    except Exception:
        return {"items": [], "count": 0}

    limit = min(int(params.get("limit", 20)), 100)
    offset = int(params.get("offset", 0))

    # Build where filter
    where = {}
    if params.get("type"):
        where["type"] = {"$eq": params["type"]}
    if params.get("session"):
        where["session"] = {"$eq": params["session"]}
    if params.get("source"):
        where["source"] = {"$eq": params["source"]}

    try:
        get_kwargs = {
            "limit": limit,
            "offset": offset,
            "include": ["documents", "metadatas"]
        }
        if where:
            get_kwargs["where"] = where

        results = col.get(**get_kwargs)

        items = []
        for i, doc_id in enumerate(results["ids"]):
            items.append({
                "id": doc_id,
                "content": results["documents"][i][:200] + ("..." if len(results["documents"][i]) > 200 else ""),
                "metadata": results["metadatas"][i] if results["metadatas"] else {},
            })

        return {"items": items, "count": col.count()}
    except Exception as e:
        return {"error": str(e), "items": [], "count": 0}


def handle_stats(params: dict) -> dict:
    client = get_client()

    try:
        # ChromaDB v0.6+: list_collections returns names only
        collection_names = client.list_collections()
        stats = {
            "memory_dir": str(MEMORY_DIR),
            "collections": []
        }
        total = 0
        for name in collection_names:
            try:
                col = client.get_collection(name)
                count = col.count()
                total += count
                stats["collections"].append({"name": name, "count": count})
            except Exception:
                stats["collections"].append({"name": name, "count": 0})
        stats["total_memories"] = total
        return stats
    except Exception as e:
        return {"error": str(e), "memory_dir": str(MEMORY_DIR), "total_memories": 0, "collections": []}


def handle_wake_up(params: dict) -> dict:
    """Get recent memories for context injection at session start."""
    client = get_client()
    session = params.get("session", "main")

    try:
        col = get_collection(client, "jarvis_memory")
        count = col.count()
        if count == 0:
            return {"context": "", "count": 0}

        # Get last N memories ordered by timestamp (most recent)
        limit = min(int(params.get("limit", 10)), 20)
        results = col.get(
            limit=limit,
            include=["documents", "metadatas"]
        )

        if not results["ids"]:
            return {"context": "", "count": 0}

        # Sort by timestamp descending
        items = []
        for i, doc_id in enumerate(results["ids"]):
            meta = results["metadatas"][i] if results["metadatas"] else {}
            items.append({
                "id": doc_id,
                "content": results["documents"][i],
                "timestamp": meta.get("timestamp", ""),
                "type": meta.get("type", "fact"),
                "source": meta.get("source", ""),
            })

        items.sort(key=lambda x: x["timestamp"], reverse=True)

        lines = ["## Recent Memory Context"]
        for item in items[:limit]:
            ts = item["timestamp"][:10] if item["timestamp"] else "?"
            lines.append(f"[{ts}][{item['type']}] {item['content'][:300]}")

        return {"context": "\n".join(lines), "count": len(items)}
    except Exception as e:
        return {"context": "", "count": 0, "error": str(e)}


# ── Dispatch ───────────────────────────────────────────────────────────────────

def handle_metrics(params: dict) -> dict:
    """Rich metrics for HUD display — type breakdown, sources, last save timestamp."""
    client = get_client()
    collection_name = params.get("collection", "jarvis_memory")

    try:
        col = get_collection(client, collection_name)
        count = col.count()
        if count == 0:
            return {"types": {}, "sources": {}, "lastSaved": None}

        # Fetch all metadata (no documents needed)
        results = col.get(include=["metadatas"], limit=min(count, 1000))
        metadatas = results.get("metadatas") or []

        types: dict = {}
        sources: dict = {}
        last_saved: str | None = None

        for meta in metadatas:
            if not meta:
                continue
            t = meta.get("type", "fact")
            types[t] = types.get(t, 0) + 1

            s = meta.get("source", "jarvis")
            sources[s] = sources.get(s, 0) + 1

            ts = meta.get("timestamp")
            if ts and (last_saved is None or ts > last_saved):
                last_saved = ts

        return {"types": types, "sources": sources, "lastSaved": last_saved}
    except Exception as e:
        return {"types": {}, "sources": {}, "lastSaved": None, "error": str(e)}


HANDLERS = {
    "add": handle_add,
    "search": handle_search,
    "delete": handle_delete,
    "list": handle_list,
    "stats": handle_stats,
    "wake_up": handle_wake_up,
    "metrics": handle_metrics,
}

def main():
    # Signal ready
    print(json.dumps({"status": "ready", "memory_dir": str(MEMORY_DIR)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            action = req.get("action")
            params = req.get("params", {})
            req_id = req.get("id")

            handler = HANDLERS.get(action)
            if not handler:
                result = {"error": f"unknown action: {action}"}
            else:
                result = handler(params)

            response = {"id": req_id, "result": result}
        except json.JSONDecodeError as e:
            response = {"error": f"invalid JSON: {e}"}
        except Exception as e:
            response = {"error": str(e), "traceback": traceback.format_exc()}

        print(json.dumps(response), flush=True)

if __name__ == "__main__":
    main()
