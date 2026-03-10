import { createQuest, getPlayerQuests } from '../models/quest.js';
import type { QuestType, DailyQuest } from '../types/index.js';
import { DAILY_QUEST_COUNT } from '../types/index.js';

interface QuestTemplate {
  type: QuestType;
  description: string;
  targetCount: number;
  rewardXp: number;
  rewardGold: number;
}

const QUEST_POOL: QuestTemplate[] = [
  { type: 'kill_monsters', description: 'Slay 3 monsters', targetCount: 3, rewardXp: 40, rewardGold: 30 },
  { type: 'kill_monsters', description: 'Slay 5 monsters', targetCount: 5, rewardXp: 70, rewardGold: 50 },
  { type: 'explore_chunks', description: 'Visit 2 new chunks', targetCount: 2, rewardXp: 35, rewardGold: 25 },
  { type: 'explore_chunks', description: 'Visit 3 new chunks', targetCount: 3, rewardXp: 50, rewardGold: 40 },
  { type: 'craft_item', description: 'Craft an item', targetCount: 1, rewardXp: 25, rewardGold: 20 },
  { type: 'craft_item', description: 'Craft 2 items', targetCount: 2, rewardXp: 45, rewardGold: 35 },
  { type: 'trade', description: 'Complete a trade', targetCount: 1, rewardXp: 30, rewardGold: 25 },
  { type: 'earn_gold', description: 'Earn 100 gold', targetCount: 100, rewardXp: 30, rewardGold: 0 },
  { type: 'earn_gold', description: 'Earn 50 gold', targetCount: 50, rewardXp: 20, rewardGold: 0 },
  { type: 'rest', description: 'Rest 2 times', targetCount: 2, rewardXp: 15, rewardGold: 15 },
];

export function generateDailyQuests(playerId: number): DailyQuest[] {
  const today = new Date().toISOString().split('T')[0];
  
  // Check if already generated today
  const existing = getPlayerQuests(playerId, today);
  if (existing.length >= DAILY_QUEST_COUNT) return existing;
  
  // Pick random quests (no duplicate types)
  const shuffled = [...QUEST_POOL].sort(() => Math.random() - 0.5);
  const selected: QuestTemplate[] = [];
  const usedTypes = new Set<QuestType>();
  
  for (const quest of shuffled) {
    if (selected.length >= DAILY_QUEST_COUNT) break;
    if (!usedTypes.has(quest.type)) {
      selected.push(quest);
      usedTypes.add(quest.type);
    }
  }
  
  const quests: DailyQuest[] = [];
  for (const tmpl of selected) {
    const quest = createQuest(playerId, tmpl.type, tmpl.description, tmpl.targetCount, tmpl.rewardXp, tmpl.rewardGold, today);
    quests.push(quest);
  }
  
  return quests;
}
