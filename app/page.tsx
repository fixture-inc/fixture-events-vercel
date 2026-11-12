import { randomUUID } from 'node:crypto';
import { connectConfig } from '../lib/config';
import { db } from '../lib/db';
import { discoverCatalog } from '../lib/connect';

export const dynamic = 'force-dynamic';

// Page IA: inspect saved events first; manage watches in the side column.
// The document owns scrolling. Setup, storage failure, and no-events are distinct.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const query = await searchParams;
  let config: ReturnType<typeof connectConfig> | undefined;
  try {
    config = connectConfig();
  } catch {
    /* Show setup without contacting Fixture. */
  }
  let events: Record<string, any>[] = [],
    watches: Record<string, any>[] = [],
    controls: Record<string, any>[] = [];
  let storageError = false;
  let catalog: { name: string; inputSchema: unknown; description?: string | null }[] = [];
  let catalogError = false;
  if (config) {
    try {
      [events, watches, controls] = await Promise.all([
        db()`SELECT * FROM events WHERE scope = ${config.scope} ORDER BY received_at DESC, event_id LIMIT 50`,
        db()`SELECT * FROM watches WHERE scope = ${config.scope} ORDER BY created_at DESC`,
        db()`SELECT * FROM controls WHERE scope = ${config.scope} ORDER BY received_at DESC LIMIT 10`,
      ]);
    } catch {
      storageError = true;
    }
    if (query.catalog) {
      try {
        catalog = await discoverCatalog();
      } catch {
        catalogError = true;
      }
    }
  }
  return (
    <main>
      <header>
        <a className="wordmark" href="/">
          Fixture<span> / events</span>
        </a>
        <span className="label">CONSUMER DEMO</span>
      </header>
      <div className="intro">
        <p className="eyebrow">VERCEL CONNECT + AI SDK</p>
        <h1>Your event inbox</h1>
        <p>Fixture events, saved before they are acknowledged.</p>
      </div>
      {!config && (
        <section className="notice">
          <h2>Configure your connection</h2>
          <p>
            Set the Connect connector, Fixture endpoint, subject, and trusted Vercel identity.
            Follow the README before authorizing a connection.
          </p>
        </section>
      )}
      {query.error && (
        <p role="alert" className="notice error">
          That action did not finish. Check your connection and configuration. Retry a saved watch
          below to reuse its original creation key.
        </p>
      )}
      {storageError && (
        <p role="alert" className="notice error">
          The inbox is unavailable. Check Postgres and run the migration. Deliveries receive 503
          until durable storage recovers.
        </p>
      )}
      <div className="columns">
        <section aria-labelledby="inbox-heading">
          <div className="section-heading">
            <h2 id="inbox-heading">
              Saved events <span>{storageError ? 'unavailable' : events.length}</span>
            </h2>
            <a href="/">Refresh inbox</a>
          </div>
          <p className="hint">
            Latest 50 receipts · newest arrival first · events can arrive out of order
          </p>
          {events.length === 0 && !storageError && (
            <div className="empty">
              <h3>No events saved yet</h3>
              <p>
                Authorize Fixture, discover the catalog, and create a watch. New matching events
                will appear here after Postgres commits them.
              </p>
            </div>
          )}
          <div className="event-list">
            {events.map((event) => (
              <article key={`${event.subscription_id}:${event.event_id}`}>
                <div className="event-heading">
                  <h3>{event.name}</h3>
                  <time dateTime={new Date(event.occurred_at).toISOString()}>
                    {new Date(event.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                  </time>
                </div>
                <p className="identity">
                  {event.subject_type} · {event.subject_id}
                </p>
                {event.redacted && <p className="redacted">Content removed after deletion</p>}
                <details>
                  <summary>View saved payload</summary>
                  <pre>{JSON.stringify(event.data, null, 2)}</pre>
                  <p className="hint">
                    Event {event.event_id}
                    <br />
                    Watch {event.subscription_id}
                  </p>
                </details>
              </article>
            ))}
          </div>
          {controls.length > 0 && (
            <section className="notice">
              <h3>Delivery notices</h3>
              <p>Inspect gaps or termination before treating this inbox as complete.</p>
              {controls.map((control) => (
                <pre key={control.delivery_id}>{JSON.stringify(control.data, null, 2)}</pre>
              ))}
            </section>
          )}
        </section>
        <aside aria-labelledby="watches-heading">
          <h2 id="watches-heading">Watches</h2>
          <p className="hint">
            Connect renews provider leases until you stop the watch. Closing a client does not stop
            delivery.
          </p>
          <form action="/actions" method="post" className="setup-actions">
            <button name="action" value="authorize" disabled={!config}>
              Authorize Fixture
            </button>
            <button name="action" value="discover" className="secondary" disabled={!config}>
              Discover events
            </button>
          </form>
          {catalogError && (
            <p role="alert" className="notice error">
              Discovery failed. Authorize Fixture with event scopes, then try again.
            </p>
          )}
          {catalog.length > 0 && (
            <form action="/actions" method="post" className="watch-form">
              <input type="hidden" name="id" value={randomUUID()} />
              <label htmlFor="name">Event</label>
              <select id="name" name="name">
                {catalog.map((event) => (
                  <option key={event.name}>{event.name}</option>
                ))}
              </select>
              <label htmlFor="arguments">Arguments (JSON)</label>
              <textarea
                id="arguments"
                name="arguments"
                defaultValue={'{"scope":"mine"}'}
                rows={3}
                required
              />
              <p className="hint">
                Lead watches require Organization scope. Inspect each event's schema below.
              </p>
              <button name="action" value="subscribe">
                Create watch
              </button>
              <details>
                <summary>Catalog schemas</summary>
                {catalog.map((event) => (
                  <div key={event.name}>
                    <h3>{event.name}</h3>
                    <p>{event.description}</p>
                    <pre>{JSON.stringify(event.inputSchema, null, 2)}</pre>
                  </div>
                ))}
              </details>
            </form>
          )}
          {watches.map((watch) => (
            <div className="watch" key={watch.id}>
              <h3>{watch.name}</h3>
              <p>
                <span className="status">{watch.status}</span>
                {watch.stop_requested && ' · stop requested'}
                {watch.cleanup_status && ` · cleanup ${watch.cleanup_status}`}
              </p>
              <code>{JSON.stringify(watch.arguments)}</code>
              <form action="/actions" method="post">
                <input type="hidden" name="id" value={watch.id} />
                <button className="secondary" name="action" value="retry">
                  {watch.remote_id ? 'Check / retry' : 'Retry creation'}
                </button>
                <button className="quiet" name="action" value="stop">
                  Stop watch
                </button>
              </form>
            </div>
          ))}
          <p className="footnote">
            Single-operator demo. Events grant no additional read or write access.
          </p>
        </aside>
      </div>
      <footer>
        Durable receipt, not exactly-once external work.{' '}
        <a href="https://vercel.com/docs/connect/mcp-events">Connect event reference ↗</a>
      </footer>
    </main>
  );
}
