import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, resetDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createPlayer } from '../src/models/player.js';
import { generateDailyQuests } from '../src/game/quests.js';
import { getPlayerQuests, getQuestStreak, updateStreak, completeQuest } from '../src/models/quest.js';

describe('Daily Quest System', () => {
  beforeEach(() => {
    resetDb();
    process.env.DATABASE_PATH = ':memory:';
    migrate();
  });

  afterEach(() => {
    resetDb();
  });

  it('generates 3 daily quests for a new player', () => {
    const player = createPlayer('QuestPlayer1', 'password123');
    const today = new Date().toISOString().split('T')[0];
    
    const quests = generateDailyQuests(player.id);
    
    expect(quests).toHaveLength(3);
    expect(quests[0].player_id).toBe(player.id);
    expect(quests[0].assigned_date).toBe(today);
    expect(quests[0].current_count).toBe(0);
    expect(quests[0].completed_at).toBeNull();
  });

  it('does not generate duplicate quests on same day', () => {
    const player = createPlayer('QuestPlayer2', 'password123');
    
    const quests1 = generateDailyQuests(player.id);
    const quests2 = generateDailyQuests(player.id);
    
    expect(quests1).toHaveLength(3);
    expect(quests2).toHaveLength(3);
    expect(quests1[0].id).toBe(quests2[0].id); // Same quests returned
  });

  it('each quest has unique type', () => {
    const player = createPlayer('QuestPlayer3', 'password123');
    const quests = generateDailyQuests(player.id);
    
    const types = quests.map(q => q.quest_type);
    const uniqueTypes = new Set(types);
    
    expect(uniqueTypes.size).toBe(3); // All different types
  });

  it('completing a quest marks it as complete', () => {
    const player = createPlayer('QuestPlayer4', 'password123');
    const quests = generateDailyQuests(player.id);
    const questId = quests[0].id;
    
    completeQuest(questId);
    
    const today = new Date().toISOString().split('T')[0];
    const updated = getPlayerQuests(player.id, today);
    const completedQuest = updated.find(q => q.id === questId);
    
    expect(completedQuest?.completed_at).not.toBeNull();
  });

  it('updateStreak creates new streak for first completion', () => {
    const player = createPlayer('QuestPlayer5', 'password123');
    const today = new Date().toISOString().split('T')[0];
    
    const streak = updateStreak(player.id, today);
    
    expect(streak.current_streak).toBe(1);
    expect(streak.total_completed).toBe(1);
    expect(streak.last_completed_date).toBe(today);
  });

  it('updateStreak increments for consecutive days', () => {
    const player = createPlayer('QuestPlayer6', 'password123');
    
    const day1 = '2024-01-01';
    const day2 = '2024-01-02';
    
    updateStreak(player.id, day1);
    const streak = updateStreak(player.id, day2);
    
    expect(streak.current_streak).toBe(2);
    expect(streak.total_completed).toBe(2);
  });

  it('updateStreak resets for non-consecutive days', () => {
    const player = createPlayer('QuestPlayer7', 'password123');
    
    const day1 = '2024-01-01';
    const day3 = '2024-01-03'; // Skipped day 2
    
    updateStreak(player.id, day1);
    const streak = updateStreak(player.id, day3);
    
    expect(streak.current_streak).toBe(1); // Reset to 1
    expect(streak.total_completed).toBe(2); // But total still increases
  });

  it('quest has rewards configured', () => {
    const player = createPlayer('QuestPlayer8', 'password123');
    const quests = generateDailyQuests(player.id);
    
    expect(quests[0].reward_xp).toBeGreaterThan(0);
    // Gold rewards can be 0 for some quests (like earn_gold type)
    expect(quests[0].reward_xp + quests[0].reward_gold).toBeGreaterThan(0);
  });
});
