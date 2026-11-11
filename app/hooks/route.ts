import {
  experimental_verifyMcpEvent,
  Experimental_McpEventVerificationError,
} from '@vercel/connect/mcp';
import { ZodError } from 'zod';
import { connectConfig, receiverConfig } from '../../lib/config';
import { db } from '../../lib/db';
import { acceptDelivery } from '../../lib/inbox';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const delivery = await experimental_verifyMcpEvent(request, receiverConfig());
    await acceptDelivery(db(), connectConfig().scope, delivery);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (
      error instanceof Experimental_McpEventVerificationError &&
      error.code === 'invalid_delivery'
    ) {
      return new Response('Invalid delivery.', { status: 401 });
    }
    if (error instanceof ZodError)
      return new Response('Unsupported Fixture payload.', { status: 422 });
    // Includes early arrival before binding, database failure, and unavailable JWKS.
    // No payloads, credentials, or callback queries enter logs or responses.
    return new Response('Receipt unavailable. Retry later.', {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }
}
