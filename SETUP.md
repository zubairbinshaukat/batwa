# Setting up shared spaces (the relay)

Everything in Batwa works without this. Shared spaces, where two or more phones keep a joint encrypted ledger, need one small server you host: a Cloudflare Worker that stores ciphertext and forwards push notifications. It never sees names, amounts, titles, accounts, or who anyone is.

Time needed: about 20 minutes, once. Cost: nothing on Cloudflare's free plan.

## 1. Prerequisites

- Node.js 18 or newer on your laptop (you already have it).
- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- This repo checked out locally.

## 2. Install and log in to Wrangler

Wrangler is Cloudflare's command-line tool.

```bash
npm i -g wrangler
wrangler login
```

The second command opens a browser tab. Approve it and come back to the terminal.

## 3. Generate the push key pair

Push notifications are signed with a key pair called VAPID. Generate it once and keep the private half secret.

```bash
npx web-push generate-vapid-keys
```

You get two long strings, `Public Key` and `Private Key`. Keep this terminal open, you will paste both in the next steps.

## 4. Tell the relay who may call it

Open `relay/wrangler.toml` and change two values under `[vars]`:

```toml
ALLOWED_ORIGIN   = "https://<your-username>.github.io"   # the origin the app is served from
VAPID_PUBLIC_KEY = "<paste the Public Key from step 3>"
```

Use the origin only, no path. For GitHub Pages that is `https://<username>.github.io`. For Netlify it is `https://<site>.netlify.app`. If you serve the app from a custom domain, use that.

Leave `ALLOW_NULL_ORIGIN = "1"` as it is. Installed apps on Android sometimes send no origin, and this lets them through.

## 5. Deploy the relay and set the secrets

```bash
cd relay
npm install
wrangler deploy
wrangler secret put VAPID_PRIVATE_KEY     # paste the Private Key from step 3
wrangler secret put VAPID_SUBJECT         # type: mailto:you@example.com
```

`wrangler deploy` prints the URL of your relay, something like:

```
https://batwa-relay.<your-subdomain>.workers.dev
```

Copy it. The first deploy also creates the Durable Object storage automatically. There is no database to create and no keys to copy from a dashboard.

Without the two secrets the relay still stores and syncs spaces, but `/notify` answers "push not configured" and phones fall back to checking for changes when the app opens.

## 6. Point the app at your relay

Open `js/config.js` and fill in the two constants:

```js
export const RELAY_URL = "https://batwa-relay.<your-subdomain>.workers.dev";
export const VAPID_PUBLIC_KEY = "<the same Public Key from step 3>";
```

Then bump the cache name in `sw.js` (for example `batwa-v25` to `batwa-v26`) and deploy the app the same way you always do. Installed phones get the "New version ready" toast.

## 7. Check it works

From the repo folder:

```bash
curl -i https://batwa-relay.<your-subdomain>.workers.dev/v1/space/AAAAAAAAAAAAAAAAAAAAAA
```

You should see `401` or `404` with `Cache-Control: no-store` in the headers. That means the relay is up and refusing anonymous reads, which is correct.

In the app, open Settings, then Shared spaces, then New space. If the space appears in the header switcher, the round trip is working.

## 8. Optional but recommended

- **Custom domain.** In the Cloudflare dashboard open the Worker, then Settings, then Domains and Routes, and add something like `relay.yourdomain.com`. Put that URL in `js/config.js` instead of the `workers.dev` one.
- **Turn off request logging.** Worker, then Settings, then Observability. Logs are the only place IP addresses would be kept, and the app's privacy note says they are not.
- **Redeploy the relay whenever the `relay/` folder changes** (after pulling an update, for example): `cd relay && wrangler deploy`. Your secrets and stored spaces survive a redeploy.
- **Run the relay tests** whenever you change it:
  ```bash
  cd relay && npm test
  ```

## What the relay can and cannot see

| It sees                                                     | It never sees                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| A random 22-character space id                              | Who is in the space                                                     |
| A hash of the space's write token                           | Names, titles, notes                                                    |
| An encrypted blob and its size                              | Amounts or balances                                                     |
| When the blob was last written                              | Which bank accounts anyone uses                                         |
| Push endpoints (Google or Apple URLs identifying a browser) | The content of a notification, which is encrypted on the sender's phone |
| The caller's IP address, like any web host                  | Your PIN or any key                                                     |

The full write-up is in `relay/README.md`.

## Troubleshooting

- **`wrangler deploy` complains about Durable Objects.** Your account needs the free-plan SQLite-backed Durable Objects. In the dashboard open Workers and Pages, then Plans, and make sure Workers Free is active. Retry the deploy.
- **The app says "Relay not configured".** `RELAY_URL` in `js/config.js` is empty or the app you are running is an older cached version. Bump the `sw.js` cache and redeploy.
- **CORS error in the browser console.** `ALLOWED_ORIGIN` does not match the origin the app is served from. It must be scheme plus host only, no trailing slash or path.
- **Notifications never arrive.** Check both secrets are set with `wrangler secret list`, that `VAPID_PUBLIC_KEY` is identical in `wrangler.toml` and `js/config.js`, and that the app is installed to the home screen. iPhones need iOS 16.4 or newer and the app installed.
