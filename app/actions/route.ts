import { ConnectError, startAuthorization } from '@vercel/connect';
import { z } from 'zod';
import { authorized, sameOrigin } from '../../lib/auth';
import { connectConfig, required } from '../../lib/config';
import { db } from '../../lib/db';
import { discoverCatalog, finishWatch } from '../../lib/connect';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!authorized(request) || !sameOrigin(request))
    return new Response('Forbidden.', { status: 403 });
  const origin = required('APP_ORIGIN');
  try {
    const form = await request.formData();
    const action = form.get('action');
    const config = connectConfig();
    if (action === 'authorize') {
      const result = await startAuthorization(config.connector, config.tokenParams, {
        callbackUrl: origin,
      });
      return Response.redirect(result.url, 303);
    }
    if (action === 'subscribe') {
      const name = z.string().min(1).max(200).parse(form.get('name'));
      const args = z.record(z.string(), z.json()).parse(JSON.parse(String(form.get('arguments'))));
      const id = z.uuid().parse(form.get('id'));
      // Discover from Fixture, not a hardcoded subset of the evolving catalog.
      const catalog = await discoverCatalog();
      if (!catalog.some((event) => event.name === name)) {
        throw new Error('Event is not available to this connection.');
      }
      await db()`INSERT INTO watches (id, scope, name, arguments)
        VALUES (${id}, ${config.scope}, ${name}, ${db().json(args)}) ON CONFLICT (id) DO NOTHING`;
      await finishWatch(id);
    } else if (action === 'retry' || action === 'stop') {
      await finishWatch(z.uuid().parse(form.get('id')), action === 'stop');
    } else if (action !== 'discover') {
      throw new Error('Unknown action.');
    }
    return Response.redirect(new URL(action === 'discover' ? '/?catalog=1' : '/', origin), 303);
  } catch (error) {
    console.error('Operator action failed', {
      category: error instanceof ConnectError ? 'connect' : 'application',
      status: error instanceof ConnectError ? error.status : undefined,
      code:
        error instanceof ConnectError && /^[a-z0-9_]{1,80}$/.test(error.code ?? '')
          ? error.code
          : undefined,
    });
    // Do not expose provider response details: they may contain OAuth credentials.
    return Response.redirect(new URL('/?error=action', origin), 303);
  }
}
