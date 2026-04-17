// pieces/index.js — JARVIS plugin entry point
import { MemoryPiece } from "./memory-piece.js";

export function createPieces(ctx) {
  return [new MemoryPiece(ctx)];
}
