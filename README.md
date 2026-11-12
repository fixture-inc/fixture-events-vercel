# Fixture events on Vercel

A single-operator event inbox built with Next.js, Vercel Connect, the AI SDK
MCP client, and shared Postgres. It discovers Fixture's authorized catalog,
creates managed watches, and displays saved events. It does not call an LLM
or perform CRM writes.

**Reference implementation with partial hosted acceptance.** The approved
[Production inbox](https://fixture-events-vercel.vercel.app/) received fake-data
events from a Fixture preview on November 12, 2026. That preview includes an
unreleased `maxAgeMs` compatibility fix in
[Fixture PR #5163](https://github.com/fixture-inc/web/pull/5163).
See the executed cases and remaining limits below.

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

Requires Node.js 24, pnpm 10, and a **disposable** Postgres database. Use fake
data. Local HTTP is suitable for the page, not for receiving real Connect events.

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

### Synthetic page preview

This CLI-only seed exercises storage, not signatures, consent, or delivery.
It refuses to run when `VERCEL` is set. It has no HTTP authentication bypass.
Use a separate local database that you can discard after review.

In `.env.local`, use placeholder configuration, never real credentials:

```dotenv
CONNECTOR_ID=synthetic-local
FIXTURE_MCP_URL=https://fixture.invalid/api/mcp
DEMO_SUBJECT_ID=synthetic-operator
FIXTURE_SCOPES=crm:read tasks:read events:read events:manage
VERCEL_PROJECT_ID=prj_synthetic
VERCEL_ORG_ID=team_synthetic
VERCEL_TARGET_ENV=production
```

```sh
DEMO_SEED=synthetic-local-only pnpm demo:seed
```

The rows are illustrative synthetic payloads, not captured Fixture events.
Do not click authorization or watch controls with placeholder configuration.
No live Fixture or Connect request runs during seeding or a normal inbox read.

## Configure Vercel Connect

These steps require permission to create shared resources and authorize exports.

Before configuring Connect, ask an authorized Fixture environment owner to
confirm that webhook and MCP event delivery is turned on for the test Organization.
Ask an Organization Owner to allow personal event exports in **Settings →
Webhooks → Personal watches**, using **Allow personal event exports**.
OAuth scopes alone do not enable event subscriptions.

1. Create a Vercel Connect OAuth connector for Fixture. Configure the approved
   Fixture environment's OAuth endpoints and existing `/api/mcp` URL. Use its
   OAuth discovery metadata, not guessed authorization or token URLs.
   Register Connect's actual hosted callback in the Fixture OAuth client.
2. Link the connector to the demo's Vercel project and stable environment.
   Use **Production or a stable Custom environment**. Connect-managed event
   subscriptions do not support Vercel Preview deployments. A fake-data
   Fixture preview can still be the upstream source.
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
- Each new MCP client clears only this operator's matching Connect token-cache
  entry before fetching credentials. Fresh consent can finish on another
  instance, so clearing the cache only on the OAuth callback is insufficient.
  This costs one credential lookup per client, not per MCP request. Revoked
  authority still fails closed; the app does not restore old watches.
- **Stop watch** commits a stop request before calling unsubscribe. The stop
  request survives a process exit. Repeat **Check / retry** until the status
  is `stopped` and cleanup is `complete`. `pending` cleanup is not completion;
  `exhausted` needs operator investigation. The app intentionally has no cron.
- Closing an MCP client does not unsubscribe. Connect continues renewal even
  when this app is idle. Stop all watches before changing scope configuration,
  removing the project, or discarding its database. Reconfiguration does not
  revoke remote watches. Keep the old configuration until cleanup completes.

Connect forwards inline and is not a durable downstream queue. Confirm that
an app `503` reaches Fixture during live acceptance. Do not acknowledge a
failed database write or rely on an in-memory task after `2xx`. Store and
surface gap/termination notices if a provider emits them. Fixture's current
webhook profile does not emit those controls or provide polling/streaming.

## Deletion and retention

Subscribe to each corresponding Lead, Task, or Deal deletion event whenever
you store that family's content. The transaction removes stored payload content
for a deleted typed subject across this account's watches. Durable tombstones
prevent delayed or replayed content from restoring it. The page shows event
history, not a synchronized current-record cache. Subject sequences are decimal
strings; do not convert them to JavaScript `Number` for ordering.

This demo has **no automatic retention job**. Use only synthetic data. Before
using customer data, define bounded payload retention, access-loss cleanup,
backup expiry, and deletion for related-record excerpts. A subject tombstone
does not remove sensitive content from database backups or other subjects.
Keep non-content deduplication IDs and tombstones through the longest replay
window you support. Do not expose the inbox publicly or treat event consent
as permission for additional reads or writes.

## Verify changes

Tests create and remove an isolated schema in a loopback-only test database.
Network doubles replace Vercel/Fixture/JWKS responses; the real installed SDKs,
RS256 signature verification, route handlers, and Postgres transactions run.

```sh
TEST_DATABASE_URL=postgres://demo@127.0.0.1:5432/fixture_events_test pnpm test
pnpm typecheck
pnpm build
```

Tests cover invalid signatures/identity, early delivery, concurrent duplicates,
failed commits, committed reads from a new connection, deletion ordering,
lost create responses, unsubscribe cleanup retries, and cross-origin rejection.
The GitHub workflow uses disposable Postgres and requires no Fixture credentials.

### Hosted acceptance results — November 12, 2026

The actual Connect relay and this Production app passed fresh consent,
11-event catalog discovery, upstream verification challenge, and signed event
storage before acknowledgement. A deliberately rejected database transaction
returned `503` without saving a receipt or event. Connect returned retryable
`502` to Fixture; its fourth attempt succeeded after the fault was removed.

Exact-body and concurrent resends kept one logical event. A sender process
exited after the receiver committed but before recording acknowledgement;
the restarted worker retried successfully without another local result.
Creation then deletion, and deletion before delayed creation, both left
tombstones and scrubbed stored content. Independent database reads confirmed
seven events and seven receipts, including redacted creation data.

Connect's scheduler renewed a watch and delivered after its original deadline.
This used a shortened preview lease and an expired verification-cache timestamp,
not a 24-hour soak. The normal provider lease policy was restored. Signing-key
generation remained one, so rollover is not proven. Vercel's published event
guide does not document a supported forced-rollover trigger. Do not edit stored
keys to manufacture that proof. Authorization-loss recovery and `needs_auth`
also remain unverified.

All three created watches report stopped with cleanup complete. A new Lead
creation and deletion produced two source occurrences but no deliveries;
the hosted inbox stayed at seven events. Four earlier failed creation intents
remain visible as `creating`, not active watches. They were not silently deleted.

The shared Fixture compatibility fix is published for review, not released.
This run does not establish compatibility with released Fixture. No beta or production
Fixture data was used. The fake-data upstream is temporary, not a service
other deployments should depend on.

### Repeat hosted acceptance

With approved fake data and a stable Vercel deployment:

- Authorize, discover, and subscribe. Observe the real upstream verification
  challenge completing and a real event reaching shared Postgres and the page.
- Wait through a provider renewal deadline; prove delivery after renewal and
  signing-key rollover. Inspect status and handle `needs_auth` after revocation.
- Force downstream `503`; prove Fixture retains/retries the event. Restore
  storage, duplicate a delivery, and prove one saved logical event.
- Restart after commit/before the sender observes the response. Prove retry
  does not repeat the local result. Exercise both deletion arrival orders.
- Unsubscribe, wait for complete cleanup, and verify new occurrences stop.
  Already authorized in-flight events can still arrive.

Do not claim these steps passed until they run against the actual services.
