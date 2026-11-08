import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

const schema = /* sql */ `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  wa_jid text not null unique,
  display_name text,
  tos_accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per linked WhatsApp device. user_id is null while a link is in progress.
create table if not exists wa_sessions (
  id uuid primary key,
  user_id uuid unique references users(id) on delete cascade,
  status text not null default 'pending_qr',
  creds_encrypted text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists wa_signal_keys (
  session_id uuid not null references wa_sessions(id) on delete cascade,
  type text not null,
  key_id text not null,
  value_encrypted text not null,
  primary key (session_id, type, key_id)
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  jid text not null,
  name text,
  -- How trustworthy \`name\` is; a lower rank never overwrites a higher one (see wa/sessionManager.ts).
  name_rank smallint not null default 0,
  is_group boolean not null default false,
  manual boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, jid)
);
alter table contacts add column if not exists name_rank smallint not null default 0;
-- Masked placeholders ("+91∙∙∙∙∙∙∙∙90") were once stored as names; clear them so real names can fill in.
update contacts set name = null, name_rank = 0 where name like '%∙%';
-- Names stored before ranking existed: source unknown, so treat them like a chat display name.
update contacts set name_rank = 2 where name is not null and name_rank = 0;

create table if not exists scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  body text not null,
  send_at timestamptz not null,
  timezone text not null,
  status text not null default 'scheduled',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scheduled_messages_user_send_at on scheduled_messages (user_id, send_at);
-- Queue columns: the scheduler claims due rows straight from this table (see scheduler.ts).
alter table scheduled_messages add column if not exists attempts smallint not null default 0;
alter table scheduled_messages add column if not exists next_attempt_at timestamptz;
alter table scheduled_messages add column if not exists locked_at timestamptz;
create index if not exists scheduled_messages_due on scheduled_messages ((coalesce(next_attempt_at, send_at)))
  where status in ('scheduled', 'retrying');
create index if not exists scheduled_messages_sending on scheduled_messages (user_id) where status = 'sending';

create table if not exists message_recipients (
  id uuid primary key default gen_random_uuid(),
  scheduled_message_id uuid not null references scheduled_messages(id) on delete cascade,
  contact_jid text not null,
  display_name text,
  unique (scheduled_message_id, contact_jid)
);

-- One row per send attempt per recipient.
create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references message_recipients(id) on delete cascade,
  status text not null,
  wa_message_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deliveries_wa_message_id on deliveries (wa_message_id);
create index if not exists deliveries_recipient on deliveries (recipient_id);
`;

export async function migrate() {
  await pool.query(schema);
}
