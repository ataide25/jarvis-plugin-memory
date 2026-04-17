// pieces/index.js
import { MemoryPiece } from "./memory-piece.js";

export function createPieces(ctx) {
  return [new MemoryPiece(ctx)];
}
