import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Experimental_McpEventDelivery as McpEventDelivery } from '@vercel/connect/mcp';
import type { Database } from './db';

const payload = z
  .object({
    payloadVersion: z.literal(1),
    subject: z.object({ type: z.string().min(1), id: z.string().min(1) }),
    subjectSequence: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(100),
  })
  .catchall(z.json());
const deletionNames = new Set(['crm.lead.deleted', 'crm.task.deleted', 'crm.deal.deleted']);

/** The stored inbox IS the demo's result. Commit every local effect before 2xx. */
export async function acceptDelivery(sql: Database, scope: string, delivery: McpEventDelivery) {
  const event = 'event' in delivery ? delivery.event : undefined;
  const data = event ? payload.parse(event.data) : undefined;
  const digest = createHash('sha256').update(JSON.stringify(delivery)).digest('hex');
  return sql.begin(async (tx) => {
    // Serialize receipt/deletion across every subscription for this account.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
    const [watch] = await tx`
      SELECT * FROM watches WHERE scope = ${scope} AND remote_id = ${delivery.subscriptionId}
        AND connector_id = ${delivery.source.connectorId}`;
    if (!watch || (event && watch.name !== event.name)) throw new Error('Unbound subscription.');
    const [previous] =
      await tx`SELECT digest FROM receipts WHERE delivery_id = ${delivery.deliveryId}`;
    if (previous) {
      if (previous.digest !== digest) throw new Error('Delivery ID reused with different content.');
      return;
    }
    await tx`INSERT INTO receipts (delivery_id, scope, subscription_id, digest)
      VALUES (${delivery.deliveryId}, ${scope}, ${delivery.subscriptionId}, ${digest})`;
    if ('control' in delivery) {
      await tx`INSERT INTO controls (delivery_id, scope, subscription_id, data)
        VALUES (${delivery.deliveryId}, ${scope}, ${delivery.subscriptionId}, ${tx.json(delivery.control)})`;
      return;
    }
    if (!event || !data) throw new Error('Missing validated event.');
    const { subject } = data;
    const deleted = deletionNames.has(event.name);
    if (deleted) {
      await tx`INSERT INTO tombstones (scope, subject_type, subject_id)
        VALUES (${scope}, ${subject.type}, ${subject.id}) ON CONFLICT DO NOTHING`;
      // Erase cached payloads, not merely their visibility on the page.
      await tx`UPDATE events SET redacted = true,
        data = jsonb_build_object('payloadVersion', 1, 'subject', data->'subject',
          'subjectSequence', data->'subjectSequence', 'redacted', true)
        WHERE scope = ${scope} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
    }
    const [tombstone] = await tx`SELECT 1 FROM tombstones
      WHERE scope = ${scope} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
    const redacted = Boolean(tombstone) && !deleted;
    const saved = redacted
      ? {
          payloadVersion: 1,
          subject,
          subjectSequence: data.subjectSequence,
          redacted: true,
        }
      : data;
    await tx`INSERT INTO events
      (scope, subscription_id, event_id, name, occurred_at, subject_type, subject_id, data, redacted)
      VALUES (${scope}, ${delivery.subscriptionId}, ${event.eventId}, ${event.name},
        ${event.timestamp}, ${subject.type}, ${subject.id}, ${tx.json(saved)}, ${redacted})
      ON CONFLICT (subscription_id, event_id) DO NOTHING`;
  });
}
