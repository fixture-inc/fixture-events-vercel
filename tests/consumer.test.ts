import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import postgres from 'postgres';
import nock from 'nock';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { POST as receive } from '../app/hooks/route';
import { POST as action } from '../app/actions/route';
import { discoverCatalog } from '../lib/connect';
import { db } from '../lib/db';
import { connectConfig } from '../lib/config';
import { proxy } from '../proxy';

// A dedicated disposable Postgres database is required; never use a deployed DB.
const testUrl = process.env.TEST_DATABASE_URL;
assert.ok(testUrl, 'Set TEST_DATABASE_URL to a disposable local Postgres database.');
const base = new URL(testUrl);
assert.ok(['localhost', '127.0.0.1', '::1'].includes(base.hostname));
const schema = `test_${randomUUID().replaceAll('-', '')}`;
base.searchParams.set('search_path', schema);
process.env.DATABASE_URL = base.toString();
Object.assign(process.env, {
  CONNECTOR_ID: 'oauth/fixture-test',
  FIXTURE_MCP_URL: 'https://fixture.invalid/api/mcp',
  DEMO_SUBJECT_ID: 'operator-test',
  FIXTURE_SCOPES: 'crm:read events:read events:manage',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_ORG_ID: 'team_test',
  VERCEL_TARGET_ENV: 'production',
  CONNECT_OIDC_ISSUER: 'https://oidc.vercel.com/demo',
  CONNECT_OIDC_AUDIENCE: 'https://vercel.com/demo',
  DEMO_USER: 'operator',
  DEMO_PASSWORD: 'test-only-password-with-at-least-32-characters',
  APP_ORIGIN: 'https://demo.invalid',
  VERCEL_OIDC_TOKEN: 'local-test-workload-token',
});
delete process.env.CONNECT_CUSTOM_ENVIRONMENT_ID;
delete process.env.VERCEL_REGION;
const scope = connectConfig().scope;
const originalFetch = globalThis.fetch;
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const operatorAuth = `Basic ${Buffer.from(`${process.env.DEMO_USER}:${process.env.DEMO_PASSWORD}`).toString('base64')}`;
let sql: ReturnType<typeof db>;
let remote = {
  id: 'connect-watch-lifecycle',
  connectorId: 'conn_test',
  projectId: 'prj_test',
  environment: 'production',
  subject: { type: 'user', id: 'operator-test' },
  name: 'crm.deal.created',
  arguments: { scope: 'mine' },
  destination: { path: '/hooks' },
  context: {},
  status: 'active',
  expiresAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cleanupStatus: 'complete',
};
let lostCreateResponse = false;
const createKeys: string[] = [];
let providerToken: string | null = 'local-provider-token';
let acceptedProviderToken = 'local-provider-token';

before(async () => {
  nock.disableNetConnect();
  nock('https://oidc.vercel.com')
    .persist()
    .get('/.well-known/jwks')
    .reply(200, { keys: [jwk] });
  process.env.VERCEL_OIDC_TOKEN = await token();
  delete process.env.VERCEL_OIDC_TOKEN_FILE;
  const admin = postgres(testUrl!);
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  sql = db();
  await sql.unsafe(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  // Replace only the network, never the actual Connect/AI SDK or JWT verifier.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === 'https://oidc.vercel.com/.well-known/jwks')
      return Response.json({ keys: [jwk] });
    const body = request.body ? await request.json() : undefined;
    if (url.hostname === 'fixture.invalid') {
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.headers.get('authorization') !== `Bearer ${acceptedProviderToken}`)
        return Response.json({ error: 'invalid_token' }, { status: 401 });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2026-07-28',
              capabilities: { events: {}, tools: {} },
              serverInfo: { name: 'Fixture test double', version: '1' },
            }
          : body.method === 'events/list'
            ? {
                events: [
                  {
                    name: 'crm.deal.created',
                    delivery: ['webhook'],
                    inputSchema: { type: 'object' },
                    payloadSchema: { type: 'object' },
                  },
                ],
              }
            : undefined;
      return Response.json(
        result
          ? { jsonrpc: '2.0', id: body.id, result }
          : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unsupported method' } },
      );
    }
    if (url.hostname === 'api.vercel.com') {
      if (url.pathname.includes('/token/')) {
        if (providerToken === null)
          return Response.json({ error: { code: 'user_authorization_required' } }, { status: 401 });
        return Response.json({
          token: providerToken,
          expiresAt: Date.now() + 3600000,
          connector: { id: 'conn_test', uid: 'oauth/fixture-test', type: 'oauth' },
        });
      }
      if (url.pathname.endsWith('/subscriptions')) {
        assert.equal(body.ttlMs, null);
        assert.deepEqual(body.tokenParams.subject, remote.subject);
        createKeys.push(body.idempotencyKey);
        if (lostCreateResponse) {
          lostCreateResponse = false;
          throw new Error('Response lost after remote create');
        }
        return Response.json(remote);
      }
      assert.deepEqual(body.expectedSubject, remote.subject);
      if (url.pathname.endsWith('/actions/get')) return Response.json(remote);
      if (url.pathname.endsWith('/actions/unsubscribe')) {
        remote = {
          ...remote,
          status: 'stopped',
          cleanupStatus: remote.cleanupStatus === 'pending' ? 'complete' : 'pending',
        };
        return Response.json(remote);
      }
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  nock.cleanAll();
  nock.enableNetConnect();
  await sql?.end();
  const admin = postgres(testUrl!);
  try {
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

async function token(overrides: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: process.env.CONNECT_OIDC_ISSUER,
    aud: process.env.CONNECT_OIDC_AUDIENCE,
    owner_id: 'team_test',
    project_id: 'prj_test',
    environment: 'production',
    iat: now,
    exp: now + 240,
    connect: { purpose: 'mcp_event_delivery', version: 1, destinationPath: '/hooks' },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })
    .sign(signingKey);
}

function envelope(name = 'crm.deal.created', subjectId = 'deal_sample') {
  const id = randomUUID();
  const data: {
    payloadVersion: number;
    subject: { type: string; id: string };
    subjectSequence: string;
    name?: string;
    deletedAt?: string;
  } = {
    payloadVersion: 1,
    subject: { type: 'deal', id: subjectId },
    subjectSequence: '2',
    name: 'Synthetic renewal',
  };
  return {
    version: 1,
    deliveryId: `delivery-${id}`,
    subscriptionId: `watch-${name}`,
    source: { type: 'mcp', connectorId: 'conn_test' },
    context: {},
    event: { eventId: `event-${id}`, name, timestamp: '2026-11-11T12:00:00Z', cursor: null, data },
  };
}
async function send(body: unknown, jwt?: string) {
  return receive(
    new Request('https://demo.invalid/hooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt ?? (await token())}`,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function bind(name: string) {
  await sql`INSERT INTO watches (id, scope, name, arguments, remote_id, connector_id, status)
    VALUES (${randomUUID()}, ${scope}, ${name}, '{}', ${`watch-${name}`}, 'conn_test', 'active') ON CONFLICT DO NOTHING`;
}

test('receiver verifies real signatures and binds project, owner, path, scope, subscription, and name', async () => {
  const event = envelope();
  assert.equal((await send(event)).status, 503, 'arrival before binding must remain retryable');
  await bind(event.event.name);
  const badKeys = await generateKeyPair('RS256');
  for (const invalid of [
    await token({}, badKeys.privateKey),
    await token({ project_id: 'prj_other' }),
    await token({ owner_id: 'team_other' }),
    await token({ aud: 'https://vercel.com/other' }),
    await token({ environment: 'preview' }),
    await token({ exp: Math.floor(Date.now() / 1000) - 120 }),
    await token({ connect: { purpose: 'ordinary-token', version: 1, destinationPath: '/hooks' } }),
    await token({
      connect: { purpose: 'mcp_event_delivery', version: 1, destinationPath: '/elsewhere' },
    }),
  ])
    assert.equal((await send(event, invalid)).status, 401);
  assert.equal(
    (await send({ ...event, source: { type: 'mcp', connectorId: 'conn_other' } })).status,
    503,
  );
  assert.equal(
    (await send({ ...event, event: { ...event.event, name: 'crm.lead.created' } })).status,
    503,
  );
  assert.equal((await send({ ...event, event: { ...event.event, data: {} } })).status, 422);
  assert.equal((await sql`SELECT * FROM receipts`).length, 0);
  assert.equal((await send(event)).status, 204);
  const [row] = await sql`SELECT * FROM events WHERE event_id = ${event.event.eventId}`;
  assert.equal(row.data.name, 'Synthetic renewal');
});

test('concurrent redelivery and distinct delivery IDs commit one event; failed commit never acknowledges', async () => {
  const event = envelope();
  const responses = await Promise.all(Array.from({ length: 12 }, () => send(event)));
  assert.ok(responses.every((response) => response.status === 204));
  assert.equal((await send({ ...event, deliveryId: randomUUID() })).status, 204);
  assert.equal((await sql`SELECT * FROM events WHERE event_id = ${event.event.eventId}`).length, 1);
  assert.equal(
    (await sql`SELECT * FROM receipts WHERE delivery_id = ${event.deliveryId}`).length,
    1,
  );
  await sql.unsafe(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$`);
  await sql.unsafe(
    'CREATE TRIGGER receipt_failure BEFORE INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt()',
  );
  const failed = envelope();
  assert.equal((await send(failed)).status, 503);
  assert.equal(
    (await sql`SELECT * FROM receipts WHERE delivery_id = ${failed.deliveryId}`).length,
    0,
  );
  await sql.unsafe('DROP TRIGGER receipt_failure ON receipts');
  assert.equal((await send(failed)).status, 204);
  // A new connection sees the result after the acknowledgement, without process memory.
  const reader = postgres(process.env.DATABASE_URL!);
  try {
    const [row] = await reader`SELECT data FROM events WHERE event_id = ${failed.event.eventId}`;
    assert.equal(row.data.name, 'Synthetic renewal');
  } finally {
    await reader.end();
  }
});

test('deletion scrubs stored content and fences delayed content across subscriptions, but not another typed identity', async () => {
  await bind('crm.deal.deleted');
  await bind('crm.deal.owner_changed');
  const first = envelope('crm.deal.created', 'deal_deleted');
  assert.equal((await send(first)).status, 204);
  const deletion = envelope('crm.deal.deleted', 'deal_deleted');
  deletion.event.data = {
    payloadVersion: 1,
    subject: { type: 'deal', id: 'deal_deleted' },
    subjectSequence: '3',
    deletedAt: '2026-11-11T12:10:00Z',
  };
  assert.equal((await send(deletion)).status, 204);
  assert.equal((await send(envelope('crm.deal.owner_changed', 'deal_deleted'))).status, 204);
  const otherType = envelope('crm.deal.created', 'deal_deleted');
  otherType.event.data.subject.type = 'task';
  assert.equal((await send(otherType)).status, 204);
  const rows = await sql`SELECT * FROM events WHERE subject_id = 'deal_deleted'`;
  for (const row of rows.filter((row) => row.subject_type === 'deal'))
    assert.equal(row.data.name, undefined);
  assert.equal(rows.find((row) => row.subject_type === 'task')?.data.name, 'Synthetic renewal');
  const deleteFirst = envelope('crm.deal.deleted', 'deal_deleted_first');
  deleteFirst.event.data = {
    ...deletion.event.data,
    subject: { type: 'deal', id: 'deal_deleted_first' },
  };
  assert.equal((await send(deleteFirst)).status, 204);
  assert.equal((await send(envelope('crm.deal.created', 'deal_deleted_first'))).status, 204);
  const [late] =
    await sql`SELECT * FROM events WHERE subject_id = 'deal_deleted_first' AND name = 'crm.deal.created'`;
  assert.equal(late.redacted, true);
  assert.equal(late.data.name, undefined);
});

test('operator lifecycle recovers lost creation with its original key and retries unsubscribe cleanup', async () => {
  const id = randomUUID();
  const submit = (operation: string) =>
    action(
      new Request('https://demo.invalid/actions', {
        method: 'POST',
        headers: { authorization: operatorAuth, origin: 'https://demo.invalid' },
        body: new URLSearchParams({
          action: operation,
          id,
          name: 'crm.deal.created',
          arguments: '{"scope":"mine"}',
        }),
      }),
    );
  lostCreateResponse = true;
  assert.equal(
    (await submit('subscribe')).headers.get('location'),
    'https://demo.invalid/?error=action',
  );
  const [pending] = await sql`SELECT * FROM watches WHERE id = ${id}`;
  assert.equal(pending.remote_id, null);
  assert.equal((await submit('retry')).headers.get('location'), 'https://demo.invalid/');
  assert.deepEqual(createKeys, [id, id]);
  const [bound] = await sql`SELECT * FROM watches WHERE id = ${id}`;
  assert.equal(bound.remote_id, remote.id);
  assert.equal((await submit('stop')).headers.get('location'), 'https://demo.invalid/');
  const [stopping] = await sql`SELECT * FROM watches WHERE id = ${id}`;
  assert.equal(stopping.stop_requested, true);
  assert.equal(stopping.cleanup_status, 'pending');
  assert.equal((await submit('retry')).headers.get('location'), 'https://demo.invalid/');
  const [stopped] = await sql`SELECT * FROM watches WHERE id = ${id}`;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.cleanup_status, 'complete');
});

test('operator pages preserve same-origin form provenance and reject cross-origin actions', async () => {
  const page = proxy(new NextRequest('https://demo.invalid/', {
    headers: { authorization: operatorAuth },
  }));
  assert.equal(page.headers.get('Referrer-Policy'), 'same-origin');
  const response = await action(
    new Request('https://demo.invalid/actions', {
      method: 'POST',
      headers: { authorization: operatorAuth, origin: 'https://evil.invalid' },
      body: new URLSearchParams({ action: 'stop', id: randomUUID() }),
    }),
  );
  assert.equal(response.status, 403);
});

test('discovery denies revoked authority and uses fresh consent despite a warm token cache', async () => {
  try {
    assert.deepEqual((await discoverCatalog()).map((event) => event.name), ['crm.deal.created']);
    // Revoke the old grant while its cached token still has an hour to live.
    providerToken = null;
    acceptedProviderToken = 'fresh-consent-token';
    await assert.rejects(discoverCatalog());
    // OAuth completed in Connect, potentially on another app instance.
    providerToken = 'fresh-consent-token';
    assert.deepEqual((await discoverCatalog()).map((event) => event.name), ['crm.deal.created']);
  } finally {
    providerToken = acceptedProviderToken = 'local-provider-token';
  }
});
