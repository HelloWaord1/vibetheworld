import { z } from 'zod';

export const RegisterSchema = z.object({
  name: z.string().min(2).max(24).regex(/^[a-zA-Z0-9_\- ]+$/, 'Name must be alphanumeric (with _ - space)'),
  password: z.string().min(3).max(64),
});

export const LoginSchema = z.object({
  name: z.string(),
  password: z.string(),
});

export const TokenSchema = z.object({
  token: z.string().uuid(),
});

export const MoveSchema = z.object({
  token: z.string().uuid(),
  direction: z.enum(['north', 'south', 'east', 'west']),
});

export const SubmitChunkSchema = z.object({
  token: z.string().uuid(),
  x: z.number().int().min(-99).max(99),
  y: z.number().int().min(-99).max(99),
  name: z.string().min(2).max(100),
  description: z.string().min(10).max(2000),
  terrain_type: z.string().min(2).max(50),
  danger_level: z.number().int().min(1).max(10),
  theme_tags: z.array(z.string()).max(10).optional().default([]),
});

export const SubmitLocationSchema = z.object({
  token: z.string().uuid(),
  parent_id: z.number().int().nullable().optional().default(null),
  name: z.string().min(2).max(100),
  description: z.string().min(10).max(2000),
  location_type: z.string().min(2).max(50).optional().default('room'),
  is_hidden: z.boolean().optional().default(false),
  discovery_dc: z.number().int().min(1).max(30).optional().default(10),
});

export const EnterSchema = z.object({
  token: z.string().uuid(),
  location_id: z.number().int(),
});

export const AttackSchema = z.object({
  token: z.string().uuid(),
  target_name: z.string(),
});

export const SaySchema = z.object({
  token: z.string().uuid(),
  message: z.string().min(1).max(500),
});

export const WhisperSchema = z.object({
  token: z.string().uuid(),
  to: z.string(),
  message: z.string().min(1).max(500),
});

export const PickupSchema = z.object({
  token: z.string().uuid(),
  item_id: z.number().int(),
});

export const DropSchema = z.object({
  token: z.string().uuid(),
  item_id: z.number().int(),
});

export const EquipSchema = z.object({
  token: z.string().uuid(),
  item_id: z.number().int(),
});

export const UseItemSchema = z.object({
  token: z.string().uuid(),
  item_id: z.number().int(),
});

export const AllocateStatsSchema = z.object({
  token: z.string().uuid(),
  strength: z.number().int().min(0).optional().default(0),
  dexterity: z.number().int().min(0).optional().default(0),
  constitution: z.number().int().min(0).optional().default(0),
  charisma: z.number().int().min(0).optional().default(0),
  luck: z.number().int().min(0).optional().default(0),
});

export const TradeOfferSchema = z.object({
  token: z.string().uuid(),
  to: z.string(),
  offer_items: z.array(z.number().int()).optional().default([]),
  offer_gold: z.number().int().min(0).optional().default(0),
  request_items: z.array(z.number().int()).optional().default([]),
  request_gold: z.number().int().min(0).optional().default(0),
});

export const TradeActionSchema = z.object({
  token: z.string().uuid(),
  trade_id: z.number().int(),
});

export const InspectSchema = z.object({
  token: z.string().uuid(),
  target: z.string(),
});
