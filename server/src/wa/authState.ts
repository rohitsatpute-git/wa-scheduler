import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { pool } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';

const serialize = (value: unknown) => encrypt(JSON.stringify(value, BufferJSON.replacer));
const deserialize = (stored: string) => JSON.parse(decrypt(stored), BufferJSON.reviver);

/**
 * Baileys auth state stored in Postgres, encrypted at rest.
 * The wa_sessions row for `sessionId` must already exist.
 */
export async function usePostgresAuthState(
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { rows } = await pool.query<{ creds_encrypted: string | null }>(
    'select creds_encrypted from wa_sessions where id = $1',
    [sessionId],
  );
  const creds: AuthenticationCreds = rows[0]?.creds_encrypted
    ? deserialize(rows[0].creds_encrypted)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const data: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return data;
        const result = await pool.query<{ key_id: string; value_encrypted: string }>(
          'select key_id, value_encrypted from wa_signal_keys where session_id = $1 and type = $2 and key_id = any($3)',
          [sessionId, type, ids],
        );
        for (const row of result.rows) {
          let value = deserialize(row.value_encrypted);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[row.key_id] = value;
        }
        return data;
      },
      async set(data) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value) {
                await client.query(
                  `insert into wa_signal_keys (session_id, type, key_id, value_encrypted) values ($1, $2, $3, $4)
                   on conflict (session_id, type, key_id) do update set value_encrypted = excluded.value_encrypted`,
                  [sessionId, type, id, serialize(value)],
                );
              } else {
                await client.query('delete from wa_signal_keys where session_id = $1 and type = $2 and key_id = $3', [
                  sessionId,
                  type,
                  id,
                ]);
              }
            }
          }
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw err;
        } finally {
          client.release();
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await pool.query('update wa_sessions set creds_encrypted = $2 where id = $1', [sessionId, serialize(creds)]);
    },
  };
}
