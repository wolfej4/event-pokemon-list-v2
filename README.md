# N3D Catalog

A customer-facing storefront for your N3D design catalog, plus an admin
panel where you set a price and a shop/order link (or leave it blank for
"request a quote") on each design.

Your N3D API key now lives only on the server — the browser never sees it.
That also sidesteps the CORS problem the pure client-side version might have
hit, since the key-holding request happens server-to-server.

## What's inside

- `server.js` / `src/` — Express backend. Holds the N3D key, syncs the
  catalog into a local JSON file (`data/db.json`), and serves two APIs:
  `/api/public/*` (no auth, powers the storefront) and `/api/admin/*`
  (password-protected, powers the admin panel).
- `public/` — the customer-facing storefront (`/`).
- `admin/` — the admin panel (`/admin`), gated by `ADMIN_PASSWORD`.
- `Dockerfile` / `docker-compose.yml` — container build + stack definition.
- `src/mailer.js` / `src/pdf.js` — SMTP sending and PDF quote generation.
- `public/sw.js` / `public/manifest.json` — offline caching and "Add to Home Screen" support for the storefront.

## Quotes: how it works

Customers tap **+** on any design (grid or detail view) to add it to a quote
request, then use the floating "Request quote" button to enter their name,
email, and optional notes. On submit, the server:

1. Looks up each requested design's price and `print_time_seconds`
2. Sums print time and converts it to an estimated lead time using
   **Printer hours available per day** and **Lead-time buffer (days)**
   (both set in `/admin` → Storefront settings)
3. Sums price for any priced items (unpriced ones are flagged "priced on
   request" rather than guessed at)
4. Renders a PDF with the design list, print time, estimated lead time, and
   estimated cost
5. Emails it to the customer via SMTP, cc'ing your notification email so you
   see every request too

If SMTP isn't configured, the storefront automatically falls back to a
plain `mailto:` link listing the requested designs — nothing breaks, it's
just less automated.

## Event / kiosk mode (for tables without full inventory on hand)

Two independent toggles in `/admin` → Event & kiosk mode:

- **Event mode** — the public storefront only shows designs you've marked
  **Featured** in the Designs table. Flip this on before a show and the
  catalog opens straight to what you actually brought, instead of your
  full library. Flip it off afterward to go back to showing everything.
  (Outside event mode, any Featured designs still surface in a "Featured"
  section above the full catalog — event mode just narrows it further.)
- **Kiosk mode** — after a stretch of inactivity (configurable, default 2
  minutes), the storefront auto-resets: closes any open modal, clears the
  current quote cart and search/filter, and scrolls back to top. This
  keeps one visitor's browsing/quote cart from leaking into the next
  person's session on a shared tablet. It doesn't lock the device itself —
  see "Running this as an actual kiosk" below for that.

## Installing on an iPad (or any phone/tablet)

Both the storefront and the admin panel are installable PWAs — from Safari,
tap **Share → Add to Home Screen** on `/` (storefront) and/or `/admin`
(admin panel). Each gets its own home screen icon and opens full-screen
without Safari's address bar, like a native app. They're separate installs
with separate icons, so you can add one or both depending on whether you
need the customer-facing catalog, your own admin tools, or both on the
device.

## Getting customers to the storefront: QR code

`/admin` → **Storefront QR code** shows a QR code customers can scan with
their phone to pull up the storefront directly — handy for a table sign at
an event. It's generated from whatever host/URL you're currently viewing
the admin panel from, so it always points at the right place (custom
domain, tunnel, raw IP:port, whatever) without needing that URL configured
anywhere. Use **Print** for a paper sign, or **Copy link** to share it
another way.

## Offline resilience

The storefront registers a service worker that caches the app shell and the
last-fetched catalog, so it keeps working if the connection drops mid-event:

- The page still loads and shows the last synced catalog, with a banner
  noting it's offline and when it was last synced.
- Adding to a quote and submitting still works — if the quote-request
  fails purely due to no connectivity, it's queued in the browser and
  sent automatically the next time the device is back online (checked
  immediately on reconnect, and once on page load).

This depends on the device having loaded the app at least once while
online. Do a sync + load the storefront on the device before you leave for
an event with uncertain wifi.

The admin panel also registers a service worker (so it's installable and
launches instantly), but it deliberately only caches its own HTML/CSS/JS —
never `/api/admin/*`. Admin data (pricing, quotes, sync/Square status) is
sensitive and needs to stay current, so it always hits the network; the
admin panel simply won't load new data while offline instead of showing you
something stale.

## Running this as an actual kiosk

Kiosk mode (above) resets the *app's* state between visitors, but nothing
in a web page can stop someone from swiping away to the home screen or
opening another app — that needs OS-level lockdown:

1. Add the storefront to the iPad's home screen (Safari → Share → Add to
   Home Screen) — it opens full-screen without Safari's address bar.
2. Turn on **Guided Access** (Settings → Accessibility → Guided Access),
   then triple-click the side/home button while the app is open to pin the
   device to just that app.

## Quote request log

Every quote attempt — sent or failed — is recorded in `/admin` under
"Quote requests": customer, items, estimated cost/lead time, and status.
Useful for following up after an event even if nobody converts on the
spot. Export the whole log as CSV from the same panel.

## Running it

### 1. Set your environment variables

Copy `.env.example` to `.env` and fill in:

- `N3D_API_KEY` — from N3D Dashboard → Tools → Design API
- `ADMIN_PASSWORD` — whatever you'll type to log into `/admin`
- `SESSION_SECRET` — a random string (`openssl rand -hex 32`)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` —
  your outgoing mail provider (see note below). Leave these blank to skip
  email quotes for now — you can add them later without losing any data.

### A note on SMTP providers

Gmail/Workspace and most consumer inboxes block plain password SMTP login
by default — you'd need an **app password**, not your normal login. For a
business sending quote emails, a transactional provider (Postmark, SES,
Mailgun, SendGrid, Resend, etc. — or your domain host's SMTP if it offers
one) tends to be more reliable and less likely to land in spam than a
personal Gmail account. Any of them will give you an SMTP host/port/user/
pass to drop into the env vars above — the app doesn't care which you use.

### 2a. Run locally with Docker Compose

```
docker compose up --build
```

Storefront: http://localhost:8090
Admin: http://localhost:8090/admin

### 2b. Deploy via Portainer

1. In Portainer, go to **Stacks → Add stack**.
2. Either point it at this project's Git repo (if you push it to one), or
   choose **Upload** / **Web editor** and paste the contents of
   `docker-compose.yml`.
3. Under **Environment variables**, add `N3D_API_KEY`, `ADMIN_PASSWORD`, and
   `SESSION_SECRET` (don't bake these into the compose file itself).
4. Deploy the stack. Portainer will build the image from the `Dockerfile` in
   this folder.
5. Once it's up, visit `http://<your-host>:8090/admin`, log in, and click
   **Sync from N3D** to pull the catalog for the first time.

If you're putting this behind a reverse proxy with HTTPS (recommended once
it's customer-facing — Traefik, Nginx Proxy Manager, Cloudflare Tunnel,
whatever you're already running on Wolfden), set `COOKIE_SECURE=true` in the
stack's environment variables so the admin session cookie requires HTTPS.

**Important:** only set `COOKIE_SECURE=true` if `/admin` is *exclusively*
reached over HTTPS. With it set, logging in over plain HTTP (a raw
`ip:port`, no TLS — e.g. testing locally, or on the same LAN as an event)
will look like it succeeds, but the browser silently won't store the
session cookie, so every request right after 401s with `not_authenticated`
— in every browser, including a fresh private window, since no session was
ever actually established. If you hit that, either turn `COOKIE_SECURE`
off or switch to accessing it over HTTPS. The server logs a warning on
startup when this is set, and the admin panel's Error log will call out
this exact cause if it happens.

## Day-to-day use

- **Sync from N3D**: pulls new/changed designs from the API. Safe to run
  often — it only fetches what changed after the first full sync.
- **New designs default to visible with no price** — they'll show "Ask for
  pricing" and a "Request a quote" button on the storefront until you set a
  price and/or shop link.
- **Set a shop link** → storefront shows "Order online" linking there,
  alongside the option to still add it to a quote request.
- **Leave the shop link blank** → the design can still be added to a quote
  request; the customer gets a PDF with estimated price and lead time
  (see "Quotes: how it works" above).
- **Uncheck Visible** to pull a design off the public site without deleting
  anything — your price/link stay saved if you turn it back on later.
- **Pixel-art sprites**: character (Pokémon) designs get a small pixel-art
  sprite badge on their card and detail photo automatically once N3D
  generates one — no admin action needed, it just shows up after a sync.
  Poke Balls, stands, and Extras don't have sprites (they aren't Pokémon),
  and a brand-new character design may take a sync or two before its sprite
  appears. A regular (incremental) sync only asks N3D for what's changed,
  which can miss a sprite that appeared on a design that's otherwise
  unchanged — so a normal "Sync from N3D" click automatically does one
  extra full-catalog pass to backfill any still-missing sprites, but only
  when at least one character design doesn't have one yet. Once every
  character design has its sprite, that extra pass stops happening and
  syncing goes back to just the incremental request.

## Pushing designs to Square

`/admin` → **Square catalog push** lets you push a design's photo and
description into your Square catalog as an item, with its price left at
**$0** so you can set the real price yourself in Square (Square Online,
Square POS, wherever you manage pricing). Push a single design from its row
in the Designs table, or use **Push all visible designs to Square** to send
everything at once.

Re-pushing an already-synced design updates the same Square item in place
(name, description, and photo if it changed) instead of creating a
duplicate.

To enable it, set in your environment:

- `SQUARE_ACCESS_TOKEN` — a Square API access token (Square Developer
  Dashboard → your application → Credentials)
- `SQUARE_LOCATION_ID` — the location the item should be attached to
- `SQUARE_ENVIRONMENT` — `sandbox` to test against Square's sandbox, or
  leave unset for production

Leave these unset to skip the feature entirely — nothing else in the app
depends on them.

## Notes / things worth knowing

- Data persistence: `docker-compose.yml` mounts a named volume
  (`n3d_catalog_data`) at `/app/data`, so your pricing and links survive
  container rebuilds/redeploys. Don't remove that volume unless you mean to
  start over.
- Sessions use an in-memory store, so logging into `/admin` won't survive a
  container restart — you'll just need to log back in, nothing is lost.
- This was built and tested as a Node app directly; the Docker image itself
  wasn't build-tested in the environment this was generated in (no Docker
  daemon available there). The Dockerfile is a plain `node:20-alpine` +
  `npm install` build with nothing unusual in it, but give it a first local
  `docker compose up --build` before pushing it into your real Portainer
  stack, just to be safe.
