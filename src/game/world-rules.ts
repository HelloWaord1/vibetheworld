import type { Chunk } from '../types/index.js';
import { MIN_CHUNK_COORD, MAX_CHUNK_COORD, DIRECTIONS } from '../types/index.js';

export function isValidChunkCoord(x: number, y: number): boolean {
  return x >= MIN_CHUNK_COORD && x <= MAX_CHUNK_COORD && y >= MIN_CHUNK_COORD && y <= MAX_CHUNK_COORD;
}

export function isFrontierChunk(x: number, y: number, existingChunks: Chunk[]): boolean {
  for (const dir of Object.values(DIRECTIONS)) {
    const adjX = x - dir[0];
    const adjY = y - dir[1];
    if (existingChunks.some(c => c.x === adjX && c.y === adjY)) return true;
  }
  if (x === 0 && y === 0) return true;
  return false;
}

export function suggestDangerLevel(x: number, y: number): number {
  return Math.min(10, 1 + Math.floor((Math.abs(x) + Math.abs(y)) / 10));
}
