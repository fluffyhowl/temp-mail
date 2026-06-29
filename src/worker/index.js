import { handleApi } from '../server/router.js';
import { loadConfig } from '../server/config.js';
import { handleInboundEmail } from '../server/email.js';
import { cleanupExpiredMessages } from '../server/jobs.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        return new Response(JSON.stringify({ error: { code: 'config_error', message: error.message } }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('RDHX Email Worker', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },

  async email(message, env, _ctx) {
    const config = loadConfig(env);
    await handleInboundEmail(message, env, config);
  },

  async scheduled(_event, env, ctx) {
    const config = loadConfig(env);
    ctx.waitUntil(cleanupExpiredMessages(env, config));
  }
};
