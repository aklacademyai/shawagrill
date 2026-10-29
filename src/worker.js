import { handleApi, runScheduled } from './api.js';
import { handleInboundEmail } from './invoice-inbound.js';
import { nyDateKey } from './time.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event));
  },
  // Supplier invoices land here once Email Routing routes
  // invoices@shawa.work to this worker; each message becomes a draft in
  // invoice_drafts for manual review in the panel.
  async email(message, env, ctx) {
    ctx.waitUntil(handleInboundEmail(message, env, nyDateKey(new Date())));
  }
};
