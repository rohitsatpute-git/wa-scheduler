# WA Scheduler

Schedule WhatsApp messages to your own contacts and groups, sent from your own number.

Users link WhatsApp as a linked device (QR code or pairing code) using [Baileys](https://github.com/WhiskeySockets/Baileys). The linked session is also the login.

> **Warning:** Baileys is an unofficial WhatsApp client. Using it breaks WhatsApp's Terms of Service, and numbers can be banned, especially for bulk or unsolicited messages. The app makes users accept this risk before linking.

## Stack

| Part | Tech |
| --- | --- |
| `server/` | Node 22, TypeScript, Express 5, Socket.IO, Baileys 7, PostgreSQL |
| `web/` | React 19, Vite, TanStack Query, React Router |
| Infra | PostgreSQL 17 via `docker-compose.yml` |

## Run locally

1. Start Postgres:

   ```sh
   docker compose up -d
   ```

   It runs on port **5433**, so it won't clash with a local install.

2. Start the server:

   ```sh
   cd server
   cp .env.example .env   # then fill in JWT_SECRET and SESSION_ENC_KEY (see comments)
   npm install
   npm run dev            # http://localhost:4000
   ```

   The schema is created automatically on startup.

3. Start the web app:

   ```sh
   cd web
   npm install
   npm run dev            # http://localhost:5173
   ```

   Vite proxies `/api` and `/socket.io` to the server, so the auth cookie works on the same origin.

4. Open http://localhost:5173. Tick the risk notice and scan the QR code under **WhatsApp → Settings → Linked devices → Link a device**.

### Production build

```sh
cd web && npm run build
cd ../server && npm run build && NODE_ENV=production npm start
```

When `web/dist` exists, the server serves it, so the whole app runs on one port.

## How it works

- **Linking:** `POST /api/auth/link/start` opens a fresh Baileys socket. QR codes (or a pairing code) are pushed to the browser over Socket.IO. When the phone accepts, the server creates the user from their WhatsApp number. The browser then swaps its one-time link secret for a JWT cookie at `POST /api/auth/link/complete`.
- **Sessions:** Baileys credentials and signal keys are stored in Postgres, encrypted with AES-256-GCM using `SESSION_ENC_KEY`. On restart, every linked session reconnects without a new scan. If the user logs the device out from their phone, the stored credentials are deleted.
- **Scheduling:** Postgres is the queue. Every 5 seconds (and right after a message is created, edited or sent now), a watcher claims due messages by switching them to `sending`, then hands them to an in-process pool of senders: up to `SEND_CONCURRENCY` (default 20) at once, and never more than one per user. Senders refresh a heartbeat before each recipient; a `sending` message whose heartbeat is over 3 minutes old was abandoned by a crashed process and is retried. On startup, anything more than 15 minutes late is marked failed.
- **Sending:** recipients get the message one at a time, with a "typing" status and a random 2–6 second gap. Failed sends retry up to 3 times with exponential backoff, skipping recipients who already got it.
- **Receipts:** WhatsApp `messages.update` receipts move each delivery from sent to delivered to read. Changes are pushed to the browser live.
- **Safety:** you can only send to your own synced contacts or groups, or to numbers you added that are confirmed to be on WhatsApp. Each message has at most `MAX_RECIPIENTS` recipients (default 50).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/link/start` | `{ acceptTos: true, phone? }` → `{ linkId, secret }` |
| POST | `/api/auth/link/complete` | `{ linkId, secret }` → sets the auth cookie |
| GET | `/api/auth/me` | Current user and WhatsApp status |
| POST | `/api/auth/logout` | Unlink the device and delete credentials |
| GET | `/api/contacts?search=` | Synced contacts and groups |
| POST | `/api/contacts` | `{ phone, name? }`; checks the number is on WhatsApp |
| GET | `/api/messages?filter=upcoming\|history` | List messages |
| GET | `/api/messages/:id` | Message plus per-recipient status |
| POST | `/api/messages` | `{ body, recipients[], sendAt, timezone }` |
| PATCH | `/api/messages/:id` | Edit (while scheduled, retrying or failed) |
| POST | `/api/messages/:id/send-now` | Send immediately |
| DELETE | `/api/messages/:id` | Cancel |

Socket.IO events (server → browser): `link:qr`, `link:pairing-code`, `link:success`, `link:failed`, `session:status`, `message:status`, `delivery:update`.

## Not built yet (roadmap phases 4–5)

- Repeating messages (daily, weekly or cron, with timezones)
- Media attachments
- Splitting session workers across processes, with Redis leases
- Hourly send quotas per user, monitoring and alerts, account deletion
