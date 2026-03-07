import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuthTools } from '../tools/auth-tools.js';
import { registerNavigationTools } from '../tools/navigation-tools.js';
import { registerChunkTools } from '../tools/chunk-tools.js';
import { registerInventoryTools } from '../tools/inventory-tools.js';
import { registerCombatTools } from '../tools/combat-tools.js';
import { registerSocialTools } from '../tools/social-tools.js';
import { registerEconomyTools } from '../tools/economy-tools.js';
import { registerInfoTools } from '../tools/info-tools.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'VibeWorld',
    version: '0.1.0',
  });

  registerAuthTools(server);
  registerNavigationTools(server);
  registerChunkTools(server);
  registerInventoryTools(server);
  registerCombatTools(server);
  registerSocialTools(server);
  registerEconomyTools(server);
  registerInfoTools(server);

  return server;
}
