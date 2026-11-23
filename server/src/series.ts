import { bus } from './bus.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { suggestMessages, type SuggestOptions } from './suggest.js';

/**
 * Repeating messages. A series (message_series) says when to send (days of the week, a local
 * time, a timezone, an optional end) and what to send:
 * - 'list': the user's messages in order, starting over after the last one;
 * - 'ai':   a fresh message written by the AI for each send.
 *
 * Each send is an ordinary row in scheduled_messages (series_id + occurrence_index), so the
 * scheduler, retries, cancel and history need nothing special. A series keeps exactly one upcoming
 * occurrence: as soon as one starts sending, is skipped or fails, ensureSeries() creates the next.
 * That gives the user a look at (and a chance to edit) the next message, AI ones included.
 */

interface SeriesRow {
  id: string;
  user_id: string;
  timezone: string;
  max_count: number | null;
  body_mode: 'list' | 'ai';
  bodies: string[];
  ai_options: SuggestOptions | null;
}

type Queryable = Pick<typeof pool, 'query'>;

/**
 * The first send time strictly after `after`, on one of the series' days, at its local time,
 * on or after starts_on and on or before ends_on. Local dates are turned into instants by
 * Postgres, so DST changes are handled. Null when the series has no more dates.
 */
export async function nextOccurrence(db: Queryable, seriesId: string, after: Date): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date }>(
    `select (g.d::date + s.time_of_day) at time zone s.timezone as at
       from message_series s,
            lateral (select greatest(s.starts_on, ($2::timestamptz at time zone s.timezone)::date) as from_day) f,
            generate_series(f.from_day::timestamp, (f.from_day + 7)::timestamp, interval '1 day') as g(d)
      where s.id = $1
        and extract(dow from g.d)::smallint = any(s.days)
        and (s.ends_on is null or g.d::date <= s.ends_on)
        and (g.d::date + s.time_of_day) at time zone s.timezone > $2
      order by 1
      limit 1`,
    [seriesId, after],
  );
  return rows[0]?.at ?? null;
}

let running = false;
let again = false;

/** Give every active series without an upcoming occurrence its next one. Safe to call often. */
export async function ensureSeries() {
  if (running) return void (again = true);
  running = true;
  try {
    do {
      again = false;
      // A series needs its next send once its latest one has been picked up (sending, sent, failed,
      // skipped). An older send that is retrying doesn't hold up the next one.
      const { rows } = await pool.query<SeriesRow>(
        `select s.id, s.user_id, s.timezone, s.max_count, s.body_mode, s.bodies, s.ai_options
           from message_series s
          where s.status = 'active'
            and not exists (
              select 1 from scheduled_messages m
               where m.series_id = s.id and m.status = 'scheduled'
                 and m.occurrence_index = (select max(x.occurrence_index) from scheduled_messages x where x.series_id = s.id))`,
      );
      for (const s of rows) {
        await createNext(s).catch((err) => logger.error({ err, seriesId: s.id }, 'series: could not schedule next'));
      }
    } while (again);
  } finally {
    running = false;
  }
}

/** Returns the new occurrence's id, or null if the series has ended (or another process won). */
export async function createNext(s: SeriesRow): Promise<string | null> {
  const { rows: stats } = await pool.query<{ next_index: number; used: number; last_at: Date | null }>(
    `select coalesce(max(occurrence_index), -1) + 1 as next_index,
            count(*) filter (where status <> 'cancelled')::int as used,
            max(send_at) as last_at
       from scheduled_messages where series_id = $1`,
    [s.id],
  );
  const { next_index: index, used, last_at: lastAt } = stats[0];

  // Never create a send in the past (e.g. after the server was down).
  const floor = new Date(Date.now() - 60_000);
  const after = lastAt && lastAt > floor ? lastAt : floor;
  const sendAt = s.max_count !== null && used >= s.max_count ? null : await nextOccurrence(pool, s.id, after);
  if (!sendAt) {
    await pool.query(`update message_series set status = 'ended', updated_at = now() where id = $1 and status = 'active'`, [
      s.id,
    ]);
    logger.info({ seriesId: s.id }, 'series ended');
    return null;
  }

  const body = await bodyFor(s, index);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string }>(
      `insert into scheduled_messages (user_id, body, send_at, timezone, series_id, occurrence_index)
       select user_id, $2, $3, timezone, id, $4 from message_series where id = $1 and status = 'active'
       on conflict (series_id, occurrence_index) do nothing
       returning id`,
      [s.id, body, sendAt, index],
    );
    const id = rows[0]?.id ?? null;
    if (id) {
      await client.query(
        `insert into message_recipients (scheduled_message_id, contact_jid, display_name)
         select $1, contact_jid, display_name from series_recipients where series_id = $2`,
        [id, s.id],
      );
    }
    await client.query('commit');
    if (id) bus.emit('message:status', s.user_id, id, 'scheduled');
    return id;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function bodyFor(s: SeriesRow, index: number): Promise<string> {
  if (s.body_mode === 'list') return s.bodies[index % s.bodies.length];

  // AI: personalise only when it goes to one person, and avoid repeating the last message.
  const [{ rows: recipients }, { rows: previous }] = await Promise.all([
    pool.query<{ name: string | null; is_group: boolean }>(
      `select coalesce(c.name, r.display_name) as name, r.contact_jid like '%@g.us' as is_group
         from series_recipients r left join contacts c on c.user_id = $2 and c.jid = r.contact_jid
        where r.series_id = $1`,
      [s.id, s.user_id],
    ),
    pool.query<{ body: string }>(
      `select body from scheduled_messages where series_id = $1 order by occurrence_index desc limit 3`,
      [s.id],
    ),
  ]);
  const only = recipients.length === 1 && !recipients[0].is_group ? recipients[0].name : null;
  const recent = new Set(previous.map((p) => p.body));
  const { suggestions } = await suggestMessages({ ...s.ai_options!, recipientName: only ?? undefined });
  const fresh = suggestions.filter((t) => !recent.has(t));
  const pool_ = fresh.length ? fresh : suggestions;
  return pool_[Math.floor(Math.random() * pool_.length)] ?? 'Hello! 👋';
}
