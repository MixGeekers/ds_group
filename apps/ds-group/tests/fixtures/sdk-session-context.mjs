import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';

// These tests exercise Session events/surfaces and the public projection
// registry. Both services ship with the pinned CLI; no AgentLoop testkit or
// extra development package is needed to construct them.
export async function createSessionContext() {
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
