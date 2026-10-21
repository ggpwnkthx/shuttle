/**
 * The schema of the shared state in a Postgres server.
 *
 * The three tables and the two functions are the equivalent of what the
 * Redis server does with its keys and its two scripts:
 *
 * | Redis | Postgres |
 * | --- | --- |
 * | a session in a key with a `PX` expiry | a row of `shuttle.sessions` with an `expires_at` |
 * | the `TOUCH_SCRIPT` | `shuttle.session_touch` |
 * | the `WINDOW_SCRIPT` | `shuttle.rate_limit_check` |
 * | a decision in a key with a `PX` expiry | a row of `shuttle.access_decisions` with an `expires_at` |
 *
 * The functions are the reason the behaviour is the same: a function call
 * is a transaction of the server, so the read, the decision and the write
 * of a window happen without another session in between, exactly like a
 * script of Redis does.
 *
 * The statements are idempotent: they can be applied to a server that
 * already holds the schema, so the bootstrap of a replica that starts
 * while another one is starting does not fail.
 */

/** The schema the tables and the functions live in. */
export const SCHEMA_NAME = 'shuttle'

/**
 * The statements that build the schema.
 *
 * They are applied by the bootstrap of the client and by the script
 * `scripts/postgres-migrate.ts`.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`,

  // The sessions of the callers. The record is the jsonb of the session;
  // the columns beside it are the moments the sweeper reads.
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.sessions (
     id                text PRIMARY KEY,
     record            jsonb NOT NULL,
     expires_at        timestamptz NOT NULL,
     absolute_expires_at timestamptz,
     updated_at        timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ${SCHEMA_NAME}_sessions_expires_at_idx
     ON ${SCHEMA_NAME}.sessions (expires_at)`,

  // The decisions of the access service.
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.access_decisions (
     key         text PRIMARY KEY,
     decision    jsonb NOT NULL,
     expires_at  timestamptz NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ${SCHEMA_NAME}_access_decisions_expires_at_idx
     ON ${SCHEMA_NAME}.access_decisions (expires_at)`,

  // The buckets of the windows of the limiters. A window holds at most
  // sixty buckets, so the state of a caller does not grow with its
  // traffic.
  `CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.rate_limit_buckets (
     key        text NOT NULL,
     bucket     bigint NOT NULL,
     requests   bigint NOT NULL DEFAULT 0,
     expires_at timestamptz NOT NULL,
     PRIMARY KEY (key, bucket)
   )`,
  `CREATE INDEX IF NOT EXISTS ${SCHEMA_NAME}_rate_limit_buckets_expires_at_idx
     ON ${SCHEMA_NAME}.rate_limit_buckets (expires_at)`,

  /**
   * Reads a session and refreshes its expiry.
   *
   * It is the counterpart of the `TOUCH_SCRIPT` of the Redis adapter:
   *
   * - it reads the record and checks the maximum age of the session, and
   *   it removes the session when it is over;
   * - it refreshes the expiry only when the touch interval is over, so a
   *   busy caller is not written on every request, and the interval is the
   *   same on every replica;
   * - the new expiry never reaches beyond the maximum age of the session;
   * - a session that was deleted (a logout) is never recreated.
   *
   * The row is locked for the duration of the call, so two replicas that
   * touch the same session at the same time do not write it twice.
   */
  `CREATE OR REPLACE FUNCTION ${SCHEMA_NAME}.session_touch(
     p_id        text,
     p_idle_ms   bigint,
     p_now       bigint,
     p_touch_ms  bigint
   ) RETURNS text
   LANGUAGE plpgsql
   AS $$
   DECLARE
     v_row        ${SCHEMA_NAME}.sessions%ROWTYPE;
     v_record     jsonb;
     v_last_touch bigint;
     v_ttl        bigint;
     v_absolute   bigint;
     v_expires    bigint;
   BEGIN
     SELECT * INTO v_row
       FROM ${SCHEMA_NAME}.sessions
      WHERE id = p_id
      FOR UPDATE;

     IF NOT FOUND THEN
       RETURN NULL;
     END IF;

     v_record   := v_row.record;
     v_absolute := COALESCE(
       (EXTRACT(EPOCH FROM v_row.absolute_expires_at) * 1000)::bigint, 0);
     v_expires  := (EXTRACT(EPOCH FROM v_row.expires_at) * 1000)::bigint;

     -- The maximum age: the session is over whatever the activity is.
     IF v_absolute > 0 AND p_now >= v_absolute THEN
       DELETE FROM ${SCHEMA_NAME}.sessions WHERE id = p_id;
       RETURN NULL;
     END IF;

     -- The idle lifetime: the row is removed when it is over, the way the
     -- expiry of a key of Redis removes it.
     IF p_now >= v_expires THEN
       DELETE FROM ${SCHEMA_NAME}.sessions WHERE id = p_id;
       RETURN NULL;
     END IF;

     v_last_touch := v_expires - p_idle_ms;

     -- The expiry is refreshed only when the touch interval is over.
     IF p_now - v_last_touch < p_touch_ms THEN
       RETURN v_record::text;
     END IF;

     v_ttl := p_idle_ms;
     IF v_absolute > 0 THEN
       v_ttl := LEAST(v_ttl, v_absolute - p_now);
     END IF;

     IF v_ttl <= 0 THEN
       DELETE FROM ${SCHEMA_NAME}.sessions WHERE id = p_id;
       RETURN NULL;
     END IF;

     v_record := jsonb_set(v_record, '{expiresAt}', to_jsonb(p_now + v_ttl));

     UPDATE ${SCHEMA_NAME}.sessions
        SET record      = v_record,
            expires_at  = to_timestamp(((p_now + v_ttl) / 1000.0)::double precision),
            updated_at  = now()
      WHERE id = p_id;

     RETURN v_record::text;
   END $$`,

  /**
   * Counts a request in the window of a key.
   *
   * It is the counterpart of the `WINDOW_SCRIPT` of the Redis adapter:
   *
   * - the buckets that left the window are removed first, so the count is
   *   the count of the last `p_window` milliseconds;
   * - a request that is over the limit is not counted, so a client that
   *   keeps hammering does not push the window further away;
   * - the `retry_after` is the time until the oldest requests of the
   *   window leave it.
   *
   * The checks of one key are serialized with an advisory lock: two
   * replicas that count the same key at the same time must not count the
   * same request twice.
   */
  `CREATE OR REPLACE FUNCTION ${SCHEMA_NAME}.rate_limit_check(
     p_key        text,
     p_now        bigint,
     p_bucket_ms  bigint,
     p_buckets    int,
     p_max        bigint
   ) RETURNS bigint[]
   LANGUAGE plpgsql
   AS $$
   DECLARE
     v_current bigint := p_now / p_bucket_ms;
     v_oldest  bigint := (p_now / p_bucket_ms) - p_buckets + 1;
     v_total   bigint := 0;
     v_allowed bigint := 1;
     v_needed  bigint;
     v_prefix  bigint := 0;
     v_retry   bigint;
     v_indices bigint[] := '{}';
     v_counts  bigint[] := '{}';
     v_index   bigint;
     v_count   bigint;
     v_i       int;
   BEGIN
     -- The checks of one key are serialized.
     PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));

     -- The buckets that left the window are forgotten.
     DELETE FROM ${SCHEMA_NAME}.rate_limit_buckets
      WHERE key = p_key AND bucket < v_oldest;

     -- The buckets of the window, in the order of their index.
     FOR v_index, v_count IN
       SELECT bucket, requests
         FROM ${SCHEMA_NAME}.rate_limit_buckets
        WHERE key = p_key AND bucket >= v_oldest
        ORDER BY bucket
     LOOP
       v_total   := v_total + v_count;
       v_indices := array_append(v_indices, v_index);
       v_counts  := array_append(v_counts, v_count);
     END LOOP;

     IF v_total >= p_max THEN
       -- The caller waits for the oldest requests of the window to leave
       -- it.
       v_allowed := 0;
       v_needed  := v_total - (p_max - 1);
       v_retry   := (v_current + p_buckets) * p_bucket_ms - p_now;
       FOR v_i IN 1..COALESCE(array_length(v_indices, 1), 0) LOOP
         IF v_prefix + v_counts[v_i] >= v_needed THEN
           v_retry := (v_indices[v_i] + p_buckets) * p_bucket_ms - p_now;
           EXIT;
         END IF;
         v_prefix := v_prefix + v_counts[v_i];
       END LOOP;
       RETURN ARRAY[v_allowed, v_total, v_retry];
     END IF;

     INSERT INTO ${SCHEMA_NAME}.rate_limit_buckets (key, bucket, requests, expires_at)
     VALUES (
       p_key,
       v_current,
       1,
       to_timestamp((((v_current + p_buckets) * p_bucket_ms) / 1000.0)::double precision)
     )
     ON CONFLICT (key, bucket) DO UPDATE
        SET requests = ${SCHEMA_NAME}.rate_limit_buckets.requests + 1;

     RETURN ARRAY[v_allowed, v_total + 1, 0];
   END $$`,
]

/**
 * The advisory lock that guards the bootstrap of the schema.
 *
 * Several replicas may start at the same time: the lock makes one of them
 * build the schema while the others wait for it.
 */
export const BOOTSTRAP_LOCK_KEY = 'shuttle_schema_bootstrap'

/** The part of the client the bootstrap needs. */
export interface SchemaClient {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
  /**
   * Runs the body in a transaction.
   *
   * The bootstrap needs it: the lock that guards the schema is held by
   * the transaction, so it is released whatever happens, and the schema is
   * built by one replica at a time.
   */
  transaction<T>(
    body: (client: {
      query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
    }) => Promise<T>
  ): Promise<T>
}

/**
 * Builds the schema of the shared state.
 *
 * The statements are idempotent and the advisory lock makes one replica
 * build the schema while the others wait for it, so a deployment whose
 * replicas start at the same time does not race with itself.
 *
 * The whole bootstrap is one transaction: a failure leaves the schema as it
 * was, and the lock of the transaction is released with it.
 */
export async function ensureSchema(client: SchemaClient): Promise<void> {
  await client.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('${BOOTSTRAP_LOCK_KEY}', 0))`)
    for (const statement of SCHEMA_STATEMENTS) {
      await tx.query(statement)
    }
  })
}
