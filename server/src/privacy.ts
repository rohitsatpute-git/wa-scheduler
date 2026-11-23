import type { Request, Response } from 'express';
import { config } from './config.js';

/**
 * Privacy policy and account-deletion page, linked from the Play Store listing and the app.
 * Play requires both a privacy policy URL and a web page explaining how to delete an account.
 * Review the wording before publishing; it describes what this codebase stores today.
 */

const APP_NAME = 'Message Scheduler';
const UPDATED = '22 November 2026';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function privacyPage(_req: Request, res: Response) {
  const contact = config.contactEmail
    ? `<a href="mailto:${escape(config.contactEmail)}">${escape(config.contactEmail)}</a>`
    : 'the contact email on our Play Store listing';
  const ai = config.ai
    ? `<li><strong>AI features.</strong> When you ask for message suggestions, use “AI writes each one”, or turn on auto-reply,
       the text needed for that request (the occasion and details you chose, and for auto-reply the recent messages in that chat)
       is sent to our AI provider to write the reply. It is not used to identify you.</li>`
    : '';

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME} – Privacy policy</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f2; --fg:#1c211f; --muted:#66706b; --accent:#128c5e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111513; --fg:#e6eae7; --muted:#98a29d; --accent:#25b37d; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
  main { max-width:720px; margin:0 auto; padding:2rem 1rem 4rem; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:2rem 0 .5rem; }
  a { color:var(--accent); } .muted { color:var(--muted); } li { margin:.35rem 0; }
</style>
</head>
<body><main>
<h1>${APP_NAME} privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>

<p>${APP_NAME} lets you schedule messages to your own contacts and groups, sent from your own WhatsApp number through a
linked device. This page explains what we store, why, and how to delete it. ${APP_NAME} is not affiliated with,
endorsed by or sponsored by WhatsApp or Meta.</p>

<h2>What we store</h2>
<ul>
  <li><strong>Your account.</strong> Your WhatsApp phone number and display name, which identify your account.</li>
  <li><strong>Linked-device session.</strong> The credentials WhatsApp issues when you link ${APP_NAME} as a device, encrypted at rest,
      so scheduled messages can be sent while the app is closed.</li>
  <li><strong>Contacts and groups.</strong> Names and numbers of your WhatsApp contacts and groups, so you can pick recipients.</li>
  <li><strong>Messages you schedule.</strong> The text, recipients, schedule (including repeating messages) and delivery status.</li>
  <li><strong>Auto-reply (only if you turn it on).</strong> For contacts you enable, the recent text of those chats, kept for 30 days,
      so replies have context. Nothing is stored for other chats.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To send the messages you schedule, at the times you choose, and show you whether they were delivered and read.</li>
  ${ai}
  <li>We do not sell your data, use it for advertising, or share it with anyone except the service providers that run the app
      (hosting and database, and the AI provider for AI features).</li>
</ul>

<h2>Security</h2>
<p>Data is sent over HTTPS. Linked-device credentials are encrypted with AES-256-GCM. Access to the servers is restricted.</p>

<h2 id="delete">Deleting your account and data</h2>
<p>In the app, open the menu and choose <strong>Delete account</strong>. This unlinks the device from your WhatsApp and permanently
deletes your account, contacts, scheduled and repeating messages, delivery history and auto-reply data. It cannot be undone.</p>
<p>If you can no longer open the app, email ${contact} from your account’s phone number details and we will delete your data
within 30 days. You can also unlink ${APP_NAME} at any time from WhatsApp: <em>Settings → Linked devices</em>; we then delete
the stored session.</p>

<h2>Children</h2>
<p>${APP_NAME} is not intended for children under 13.</p>

<h2>Changes and contact</h2>
<p>We will update this page if this policy changes. Questions: ${contact}.</p>
</main></body></html>`);
}
