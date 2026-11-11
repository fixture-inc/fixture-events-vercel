import { randomUUID } from 'node:crypto';
import { connectConfig } from '../lib/config';
import { db } from '../lib/db';
import { acceptDelivery } from '../lib/inbox';

// CLI-only fixture, never a public route or authentication bypass.
if (process.env.VERCEL || process.env.DEMO_SEED !== 'synthetic-local-only') {
  throw new Error('Seeding is only available locally with DEMO_SEED=synthetic-local-only.');
}
const sql = db();
const { scope } = connectConfig();
try {
  for (const [name, title, subject, sequence] of [
    ['crm.deal.stage_changed', 'Northstar · Annual renewal', 'deal_northstar_demo', '4'],
    ['crm.task.assignee_changed', 'Prepare buyer handoff', 'task_handoff_demo', '2'],
    [
      'notification.created',
      'Your weekly pipeline summary is ready',
      'notification_weekly_demo',
      '1',
    ],
  ]) {
    const watch = `synthetic-${name}`;
    await sql`INSERT INTO watches (id, scope, name, arguments, remote_id, connector_id, status)
      VALUES (${randomUUID()}, ${scope}, ${name}, '{"scope":"mine"}', ${watch}, 'synthetic-local', 'active')
      ON CONFLICT DO NOTHING`;
    await acceptDelivery(sql, scope, {
      version: 1,
      deliveryId: `synthetic-delivery-${name}`,
      subscriptionId: watch,
      source: { type: 'mcp', connectorId: 'synthetic-local' },
      context: {},
      event: {
        eventId: `synthetic-event-${name}`,
        name,
        timestamp: '2026-11-11T12:30:00Z',
        cursor: null,
        data: {
          payloadVersion: 1,
          subject: { type: subject.split('_')[0], id: subject },
          subjectSequence: sequence,
          title,
          synthetic: true,
        },
      },
    });
  }
  console.log('Saved three synthetic local events. No Fixture or Vercel request ran.');
} finally {
  await sql.end();
}
