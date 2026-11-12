import { isDeepStrictEqual } from 'node:util';
import { createMCPClient } from '@ai-sdk/mcp';
import { deleteTokenCacheEntry } from '@vercel/connect';
import { connectAuthProvider, experimental_connectEventsAdapter } from '@vercel/connect/ai-sdk';
import {
  experimental_getSubscription as getSubscription,
  experimental_unsubscribe as unsubscribe,
} from '@vercel/connect/mcp';
import { connectConfig } from './config';
import { db } from './db';

export async function client() {
  const { connector, tokenParams, mcpUrl } = connectConfig();
  // Consent may finish on another instance. Resolve current authority once per
  // client, then let the SDK reuse that token for this client's requests.
  deleteTokenCacheEntry(connector, tokenParams);
  return createMCPClient({
    transport: {
      type: 'http',
      url: mcpUrl,
      authProvider: connectAuthProvider(connector, tokenParams),
    },
    experimental_events: {
      adapter: experimental_connectEventsAdapter({
        connector,
        tokenParams,
        destination: { path: '/hooks' },
      }),
    },
  });
}

export async function discoverCatalog() {
  const mcp = await client();
  try {
    const events = [];
    let cursor: string | undefined;
    do {
      const page = await mcp.experimental_events.list({ params: { cursor } });
      events.push(...page.events);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return events;
  } finally {
    await mcp.close();
  }
}

export async function finishWatch(id: string, stop = false) {
  const sql = db();
  const config = connectConfig();
  const [watch] = await sql`SELECT * FROM watches WHERE id = ${id} AND scope = ${config.scope}`;
  if (!watch) throw new Error('Watch not found.');
  if (stop) await sql`UPDATE watches SET stop_requested = true WHERE id = ${id}`;
  let remoteId: string = watch.remote_id;
  if (!remoteId) {
    const mcp = await client();
    try {
      const remote = await mcp.experimental_events.subscribe({
        name: watch.name,
        arguments: watch.arguments,
        idempotencyKey: watch.id,
        ttlMs: null,
      });
      remoteId = remote.id;
    } finally {
      await mcp.close();
    }
  }
  const remote = await getSubscription(config.connector, {
    id: remoteId,
    expectedSubject: config.tokenParams.subject,
  });
  if (
    remote.projectId !== config.projectId ||
    remote.environment !== config.environment ||
    remote.name !== watch.name ||
    remote.destination.path !== '/hooks' ||
    !isDeepStrictEqual(remote.subject, config.tokenParams.subject) ||
    !isDeepStrictEqual(remote.arguments, watch.arguments)
  ) {
    throw new Error('Connect returned an unexpected subscription binding.');
  }
  // Commit ownership before accepting callbacks. Early callbacks receive 503.
  await sql`UPDATE watches SET remote_id = ${remote.id}, connector_id = ${remote.connectorId},
    status = ${remote.status}, cleanup_status = ${remote.cleanupStatus ?? null}, updated_at = now()
    WHERE id = ${id}`;
  const [current] = await sql`SELECT stop_requested FROM watches WHERE id = ${id}`;
  if (current.stop_requested) {
    const stopped = await unsubscribe(config.connector, {
      id: remote.id,
      expectedSubject: config.tokenParams.subject,
    });
    await sql`UPDATE watches SET status = ${stopped.status},
      cleanup_status = ${stopped.cleanupStatus ?? null}, updated_at = now() WHERE id = ${id}`;
  }
}
