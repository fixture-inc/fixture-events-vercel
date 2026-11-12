# Fixture events on Vercel

A single-operator event inbox built with Next.js, Vercel Connect, the AI SDK
MCP client, and shared Postgres. It discovers Fixture's authorized catalog,
creates managed watches, and displays saved events. It does not call an LLM
or perform CRM writes.

Open the [event inbox](https://fixture-events-vercel.vercel.app/).

This project uses the [MIT license](LICENSE).

## What owns each step

1. The operator authorizes Fixture through Connect's hosted OAuth flow.
   Connect stores provider credentials; this app never stores them.
2. The AI SDK discovers events through Fixture's existing `/api/mcp` endpoint.
   Its Connect adapter creates a watch using the configured user subject.
3. Connect provisions the upstream HTTPS callback and signing key. It answers
   Fixture's verification challenge, verifies Standard Webhooks signatures,
   and renews the provider's lease. `ttlMs: null` means watch until stopped,
   not an infinite upstream lease. The app must not schedule `events.refresh()`.
4. Connect forwards verified events to `POST /hooks`. The app uses the SDK's
   `experimental_verifyMcpEvent` to verify the signed Vercel OIDC bearer token
   and envelope. This hop relies on HTTPS, **not a body HMAC signature**.
   Tokens are purpose/destination-bound, not bound to an individual body.
   Never log, expose, or accept them from a browser.
5. A Postgres transaction validates the saved subscription/connector/account
   binding, deduplicates receipt and logical event, and saves the display data.
   Only then does `/hooks` return `204`. Storage failure or an early callback
   before the binding commits returns retryable `503`.

The inbox is the demo's application result. No work remains in process memory
after acknowledgement. An application that adds notifications or AI work must
also commit a durable job or recoverable work marker before acknowledging.
External effects need their own idempotency keys; this is not exactly-once work.

## Run locally

Requires Node.js 24, pnpm 10, and a local Postgres database.
Local HTTP is suitable for the page. Receiving Connect events requires HTTPS.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Set DATABASE_URL, DEMO_USER, and a random DEMO_PASSWORD of 32+ characters.
pnpm db:migrate
pnpm dev
```

Open the local development page and enter the operator credentials. Missing
Connect configuration shows setup instructions without contacting Fixture.
Never commit `.env.local`. Migration is explicit, not part of every request
or Vercel build. Use a pooled database connection string with TLS for hosting.

## Configure Vercel Connect

These steps require permission to create shared resources and authorize exports.

Before configuring Connect, make sure that webhook and MCP event delivery is
enabled for your Organization.
Ask an Organization Owner to allow personal event exports in **Settings →
Organization → Webhooks → Personal watches**, using **Allow personal event exports**.
OAuth scopes alone do not enable event subscriptions.

1. Create a Vercel Connect OAuth connector for Fixture. Configure the approved
   Fixture environment's OAuth endpoints and existing `/api/mcp` URL. Use its
   OAuth discovery metadata, not guessed authorization or token URLs.
   Register Connect's actual hosted callback in the Fixture OAuth client.
2. Link the connector to the demo's Vercel project and stable environment.
   Use **Production or a stable Custom environment**. Connect-managed event
   subscriptions do not support Vercel Preview deployments.
3. Configure the variables in `.env.example` for that environment. Set
   `APP_ORIGIN` to the exact canonical HTTPS origin. `/hooks` must not redirect
   or require operator Basic auth or a Vercel deployment-protection login.
   Keep operator auth on every other application route.
4. Enable the project's OIDC identity. Match `CONNECT_OIDC_ISSUER` to its issuer
   mode and `CONNECT_OIDC_AUDIENCE` to its audience. Set trusted project/team
   IDs. For Custom environments, also set the stable `env_…` ID. Never infer
   these from incoming `Host`, forwarding headers, event context, or tokens.
5. Run the migration against the shared demo database before accepting events.
   Deploy with the standard Next.js preset and Node.js 24. The lockfile pins
   Connect 2.9.1 and AI SDK MCP 2.0.97; both event APIs are experimental.
6. Sign in as the demo operator and click **Authorize Fixture**. Complete fresh
   explicit consent with `events:read`, `events:manage`, and the relevant domain
   read scopes. `DEMO_SUBJECT_ID` identifies this operator in your app, not the
   developer's Vercel dashboard account. Keep it stable.
7. Click **Discover events**. Read the event's input schema, enter arguments,
   and create a watch. Lead watches need `{"scope":"organization"}`. Task and
   Deal watches default to `{"scope":"mine"}`. New event families can require
   new domain scopes and explicit consent. The catalog reflects that authority.

For the Fixture connector, use `https://api.fixture.app/api/mcp` for production
or `https://beta-api.fixture.app/api/mcp` for beta. Choose the environment that
contains your data. The demo's Vercel environment must still be Production or
Custom, even when it connects to Fixture beta.

The catalog includes Lead creation/deletion, Task assignment/deletion, Deal
creation/transitions/deletion, mentions, Meeting content readiness, and
`notification.created`. Form submissions are Organization-webhook-only and do
not appear here. Mentions need both `crm:read` and `tasks:read`; Meeting content
needs `crm:read`. Both accept only `{"scope":"mine"}`. Notifications also use
`mine`. Fresh OAuth event consent authorizes all supported types within your
requested read scopes. Choose `{"scope":"mine","all":true}` or a nonempty `keys`
array when subscribing, not on the OAuth consent page. If discovery omits `all`,
obtain fresh event consent before creating an all-types watch. Do not combine
`all` and `keys`. Meeting follow-up Notifications also need `tasks:read`.
The example's default scopes cover these read requirements, but you must still
approve event consent.

Use the SDK calls shown in `lib/connect.ts` rather than inventing a new
dispatcher, bypassing callback restrictions, or storing webhook keys yourself.
See [Vercel's event guide](https://vercel.com/docs/connect/mcp-events) and
[AI SDK MCP events](https://ai-sdk.dev/docs/ai-sdk-core/mcp-events).

## Subscription lifecycle and recovery

- Creation intent and its UUID commit before calling Connect. If a response
  disappears, **Retry creation** reuses that UUID as `idempotencyKey`.
  Do not submit a new create form to recover an uncertain result.
- A saved binding records Connect's watch ID and opaque connector ID. It is
  scoped to the configured user, project, environment, endpoint, and scopes.
  Unbound deliveries receive `503`, not an acknowledgement or implicit grant.
- **Check / retry** reads the remote status with `expectedSubject` supplied.
  `pending` is not active delivery. `needs_auth` requires authorization again.
  `failed` and `expired` require investigation, not silent re-creation.
- After access loss, click **Authorize Fixture** again and complete fresh
  consent. Create a new watch after reauthorizing; revoked watches stay revoked.
- Each new MCP client clears only this operator's matching Connect token-cache
  entry before fetching credentials. Fresh consent can finish on another
  instance, so clearing the cache only on the OAuth callback is insufficient.
  This costs one credential lookup per client, not per MCP request. Revoked
  authority still fails closed; the app does not restore old watches.
- **Stop watch** commits a stop request before calling unsubscribe. The stop
  request survives a process exit. Repeat **Check / retry** until the status
  is `stopped` and cleanup is `complete`. `pending` cleanup is not completion;
  `exhausted` needs operator investigation. The app intentionally has no cron.
  Already authorized in-flight events can still arrive.
- Closing an MCP client does not unsubscribe. Connect continues renewal even
  when this app is idle. Stop all watches before changing scope configuration,
  removing the project, or discarding its database. Reconfiguration does not
  revoke remote watches. Keep the old configuration until cleanup completes.

Connect forwards inline and is not a durable downstream queue. Confirm that
an app `503` reaches Fixture and triggers its retry policy. Do not acknowledge a
failed database write or rely on an in-memory task after `2xx`. Store and
surface gap/termination notices if a provider emits them. Fixture's current
webhook profile does not emit those controls or provide polling/streaming.

For delivery errors or missing history, open **MCP → Connected clients** in
Fixture and select the watch. Inspect its lease, paused state, attempts, and
gaps. After fixing the receiver, use **Replay held events** for retained backlog
or **Redeliver** for a failed or exhausted delivery. Renewal alone does neither.
The direct Fixture protocol also supports `maxAgeMs` on cursor-bearing renewals;
this demo leaves that option unset. See the
[Fixture webhook and MCP reference](https://fixture.ai/docs/api-reference/webhooks#leases-keys-and-recovery)
for age limits, explicit recovery, and the 30-day retention window.

## Deletion and retention

Subscribe to each corresponding Lead, Task, or Deal deletion event whenever
you store that family's content. The transaction removes stored payload content
for a deleted typed subject across this account's watches. Durable tombstones
prevent delayed or replayed content from restoring it. The page shows event
history, not a synchronized current-record cache. Subject sequences are decimal
strings; do not convert them to JavaScript `Number` for ordering.

This demo has **no automatic retention job**. Before storing customer data,
define bounded payload retention, access-loss cleanup,
backup expiry, and deletion for related-record excerpts. A subject tombstone
does not remove sensitive content from database backups or other subjects.
Keep non-content deduplication IDs and tombstones through the longest replay
window you support. Do not expose the inbox publicly or treat event consent
as permission for additional reads or writes.

## Verify changes

Use a loopback-only test database. Tests create and remove an isolated schema.

```sh
TEST_DATABASE_URL=postgres://demo@127.0.0.1:5432/fixture_events_test pnpm test
pnpm typecheck
pnpm build
```
