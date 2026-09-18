# Batwa relay

A small Cloudflare Worker that lets two or three phones share an encrypted
ledger. It is a post box, not a server: it stores ciphertext under a random id
and forwards Web Push notifications. There are no accounts, no user table, no
emails, and nothing to sign up for.

Batwa works without it. Personal sync still goes to JSONBin; this relay is only
the transport for **shared spaces**.

## What it stores

Per space, in one Durable Object keyed by the space id:

| Field | What it is |
|---|---|
| `tokenHash` | `sha256(write token)` — the token itself never reaches the relay |
| `version` | a counter, bumped on every accepted write |
| `blob` | the opaque ciphertext the app PUT (≤ 1 MiB) |
| `updatedAt` | ISO timestamp of the last write |
| `sub:<deviceId>` | a browser PushSubscription plus the member id that owns it |

## What it can see

- A random 22-character space id (128 bits), which means nothing on its own.
- A hash of the write token.
- The size of your ciphertext and the times you wrote it.
- Push endpoints (one URL per device, issued by Google/Apple/Mozilla) and the
  IP addresses that call it.

## What it can never see

Names, amounts, titles, categories, accounts, dates, who owes whom, or the text
of a notification. Everything inside `blob` is encrypted on the phone with a key
that only travels inside an invite code. Notification bodies are encrypted a
second time with a per-space notification key before they are handed over, so
the relay forwards bytes it cannot read.

Request and response bodies are never logged. Every response is
`Cache-Control: no-store`. CORS is locked to `ALLOWED_ORIGIN` (plus the literal
`null` origin an installed PWA sends).

## API

All JSON, all under `/v1`. Every request carries `X-Space-Token: <token>`.
`:id` must be 22 characters of base64url or the request is `400 bad-space-id`.

| Route | Body | Result |
|---|---|---|
| `PUT /v1/space/:id` | `{ version, blob }`, header `If-Match: "<version>"` | `201 {version, updatedAt}` on create, `200` after. `412 {version, blob}` when someone else wrote first. `413` when `blob` > 1 MiB. `version` is the version you last saw; `0` creates. `If-Match: *` overwrites unconditionally. |
| `GET /v1/space/:id` | — | `200 {version, blob, updatedAt}` with `ETag: "<version>"`; `304` when `If-None-Match` matches |
| `HEAD /v1/space/:id` | — | `200` with `ETag` and `X-Version`, no body — cheap polling |
| `PUT /v1/space/:id/sub/:deviceId` | `{ memberId, subscription }` | `200 {subscribed:true}` |
| `DELETE /v1/space/:id/sub/:deviceId` | — | `200 {unsubscribed:true}` |
| `POST /v1/space/:id/notify` | `{ payload, exceptDeviceId }`, header `X-Space-Id` | `200 {sent, gone, goneDevices}`. `payload` is base64 ciphertext ≤ 3 KiB; endpoints answering 404/410 are pruned |
| `POST /v1/space/:id/rotate` | `{ newTokenHash }` (64 hex chars) | `200 {rotated:true, version}` — old invites stop working, the blob survives |
| `DELETE /v1/space/:id` | — | `200 {deleted:true}` — blob and every subscription are erased |

Auth failures are `401 unauthorised`, unknown spaces `404 not-found`.

Limits: 60 writes and 30 notifies per space per minute, 600 requests per IP per
minute (the IP window is per Worker isolate, so it is a brake rather than a
guarantee). Over the limit is `429` with `Retry-After: 60`.

The push payload the browser receives is `{"s": "<spaceId>", "p": "<ciphertext>"}`
encrypted per RFC 8291 (`aes128gcm`) and signed with VAPID per RFC 8292. Both are
implemented in `src/push.js` with Web Crypto only — the deployed Worker has no
runtime dependencies at all.

## Self-hosting

You need a free Cloudflare account. About twenty minutes, once.

1. **Sign up** at <https://dash.cloudflare.com>.
2. **Install Wrangler** and log in:
   ```
   npm i -g wrangler
   wrangler login
   ```
3. **Generate a VAPID key pair** (used to sign push messages):
   ```
   npx web-push generate-vapid-keys
   ```
   Keep the private key secret.
4. **Edit `relay/wrangler.toml`**: set `ALLOWED_ORIGIN` to your app's origin
   (for example `https://you.github.io`) and `VAPID_PUBLIC_KEY` to the public
   key from step 3.
5. **Deploy and set the secrets**:
   ```
   cd relay
   wrangler deploy
   wrangler secret put VAPID_PRIVATE_KEY
   wrangler secret put VAPID_SUBJECT        # mailto:you@example.com
   ```
6. **Point the app at it**: put the Worker URL
   (`https://batwa-relay.<your-subdomain>.workers.dev`, or a custom domain such
   as `relay.batwa.app`) and the VAPID public key into `js/config.js`, bump the
   cache name in `sw.js`, and deploy the app.
7. **Optional**: turn off request logging in the Cloudflare dashboard, and add a
   custom domain. Durable Object storage is created automatically on the first
   write to each space — there is no database to set up.

## Tests

```
cd relay
npm install
npm test
```

This boots `wrangler dev --local` on ports 8787 and 8788 and runs `node:test`
against it: create, wrong token, `If-Match` conflict, 413, `HEAD`/`ETag`/`304`,
subscribe and notify (asserting the `aes128gcm` payload decrypts with the test
subscription's own keys), 404/410 pruning, rotate, delete, the per-space write
limit, and CORS. A second file drives the app's own `js/relay.js` against the
same dev worker.

The fake push service lives in the worker itself and only exists when the
`TEST_MODE` var is set, which the test harness passes on the command line. It is
never enabled by `wrangler.toml`, so a deployed relay does not have it.

MIT licensed, like the rest of Batwa.
