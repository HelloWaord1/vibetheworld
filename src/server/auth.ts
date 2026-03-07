import { getPlayerByToken } from '../models/player.js';
import type { Player } from '../types/index.js';

export function authenticate(token: string): Player {
  const player = getPlayerByToken(token);
  if (!player) throw new Error('Invalid or expired token. Please login again.');
  if (!player.is_alive) throw new Error('This character is dead. Register a new character.');
  return player;
}
