import { d20 } from './dice.js';
import type { Player, Location } from '../types/index.js';
import { hasDiscovered, recordDiscovery } from '../models/discovery.js';

export function tryDiscover(player: Player, location: Location): { success: boolean; roll: number; dc: number } {
  if (!location.is_hidden) return { success: true, roll: 0, dc: 0 };
  if (hasDiscovered(player.id, location.id)) return { success: true, roll: 0, dc: 0 };

  const roll = d20() + Math.floor(player.luck / 2);
  const dc = location.discovery_dc;

  if (roll >= dc) {
    recordDiscovery(player.id, location.id);
    return { success: true, roll, dc };
  }

  return { success: false, roll, dc };
}
