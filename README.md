# N3D Catalog

Customer-facing catalog of your N3D designs with a quote builder, plus an admin
panel for pricing, N3D sync, and pushing to Square. Light and dark mode on both.

## What it does

**Storefront (`/`)**
- Browse, search (name, type, Pokédex #), and filter designs. Each card shows a
  strip of the design's actual filament colors.
- Add designs to a quote, change quantities, and submit name/email/phone/notes.
- The server prices every line itself, builds a PDF estimate, and emails it to
  the customer and to you. The customer can also open the PDF right away.
- Light/dark toggle in the header. Follows the device setting until someone
  picks one, then remembers it.

**Admin (`/admin`)**
- **Designs:** sync from N3D (incremental or full), set a custom price per
  design, add a "Buy online" link, hide/show designs, push single designs to Square.
- **Pricing:** formula for any design without a custom price:
  `(base fee + grams × per-gram + hours × per-hour) × (1 + markup%)`, with a
  minimum and optional round-up. Live preview as you type.
- **Quotes:** every request with status (new/contacted/won/lost), PDF, resend
  email, CSV export.
- **Square:** test connection, push everything (runs in the background with a
  progress bar). Items get name, description, photo, and price. Designs priced
  at $0 go up as variable-price items. Re-pushing updates the existing item
  instead of duplicating it and only re-uploads the photo if N3D changed it.
  Turn off "Update prices in Square when re-pushing" if you'd rather manage
  prices in Square after the first push.
- **Settings:** business name, tagline, your quote email, phone, PDF fine print,
  kiosk timeout, and connection tests.
- **Logo:** upload under Settings. Optional second version for dark mode. Shown in
  the store header, admin bar, browser tab, and on quote PDFs (PNG/JPG only for
  the PDF). Stored on the data volume, so no rebuild is needed to change it.

**Kiosk mode** for a booth tablet: open `/?kiosk=1` once on that device. Hides
outside shop links, uses bigger buttons, and clears everything after the idle
timeout. `/?kiosk=0` turns it off.

## Deploy in Portainer

1. Push this folder to a Git repo (recommended) or upload it to the Docker host.
2. Portainer → Stacks → Add stack → Repository (or Upload) with `docker-compose.yml`.
3. Add the environment variables from `.env.example`. At minimum:
   `N3D_API_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and the `SMTP_*` values.
   Add `SQUARE_ACCESS_TOKEN` for Square (try `SQUARE_ENV=sandbox` with a sandbox
   token first).
4. Deploy, open `http://<host>:8090/admin`, log in, and click **Sync from N3D**.
5. Set your business email in Settings so you get a copy of each quote.

Behind HTTPS (Nginx Proxy Manager, Traefik, Cloudflare Tunnel), set
`COOKIE_SECURE=true`.

## Deploy in Dockge (compose file only)

1. Push this folder to GitHub. The included workflow builds
   `ghcr.io/wolfej4/n3d-catalog:latest` on every push to `main` (check the Actions tab).
2. In Dockge, create a stack with the contents of `compose.dockge.yaml` and paste
   your values from `.env.example` into the `.env` box.
3. If the package is private, run `docker login ghcr.io -u wolfej4` on the host once
   (a personal access token with `read:packages` as the password), or make the
   package public under GitHub → Packages → Package settings.
4. To update later: push to GitHub, wait for the build, then click Update in Dockge.

## Notes

- Data (designs, prices, quotes, settings) lives in `/app/data/db.json` on the
  `n3d_catalog_data` volume. Back up that volume.
- If SMTP isn't configured, quotes are still saved and the customer can still
  open their PDF; the Quotes tab shows the email as not sent, and you can
  resend once SMTP works.
- Square token scopes: `ITEMS_READ`, `ITEMS_WRITE`, and `MERCHANT_PROFILE_READ`
  (for the connection test).
- Admin logins are in memory, so a container restart logs you out. Nothing else is lost.
- Quote submissions are rate limited per IP (8 per 10 minutes) and have a
  honeypot field for bots.
