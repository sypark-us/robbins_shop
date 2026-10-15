# Robbins Shop

A self-hosted online shop. Upload products (computer parts, used items, clothing, anything), customers browse, add to cart and pay with **Stripe Checkout** (credit/debit cards, Apple Pay, Google Pay, Link and any other payment method you enable in Stripe). Runs on plain Node.js with **zero npm dependencies**: SQLite comes from Node's built-in `node:sqlite`.

## Features

**Storefront**
- Home page with featured products and new arrivals, category chips
- Catalog with search, category filter, condition filter (new / like new / used / refurbished / for parts), sorting and pagination
- Product pages with photo gallery, price and compare-at price, stock level, SKU, description
- Cart with quantity edits, stock validation, flat shipping with free-shipping threshold, sales tax
- Guest checkout or customer accounts (register / log in, order history)
- Order tracking page by order number + email, status and tracking number
- JSON API: `/api/products`, `/api/health`

**Languages**
- English (default) and Korean (한국어) for the storefront and the admin, switchable from the header; the choice is remembered per visitor (`?lang=ko` / `?lang=en`)
- Products and categories take an optional Korean name and description; English is shown wherever the Korean text is empty
- Search matches both languages; prices and dates follow the selected language; Stripe Checkout opens in the same language

**Currency display**
- Prices are stored and charged in one base currency (Settings → Currency, e.g. `usd`)
- Optionally show a second currency (default `krw`): visitors get a USD | KRW switch in the header, Korean-language visitors default to KRW, and converted amounts are marked as approximate at checkout
- The exchange rate is entered in Settings or refreshed automatically once a day from European Central Bank data (frankfurter.app, no API key); admin pages always show the base currency

**Payments**
- Stripe hosted Checkout: redirect, verify on return, and authoritative confirmation via signed webhooks
- Handles expired/failed sessions (order cancelled, stock released), refunds from the admin (and `charge.refunded` webhooks)
- **Test mode** out of the box: with no Stripe key configured a simulated payment page is shown so you can try the whole flow locally

**Admin** (`/admin`)
- Dashboard: revenue, paid orders, orders to ship, low stock
- Products: create / edit / delete, multiple photo upload (JPG, PNG, GIF, WebP, validated by content, up to 8 per product), main photo selection, draft/active/archived status, featured flag
- Categories
- Orders: search and filter, status updates (pending → paid → shipped → delivered / cancelled / refunded), tracking numbers, customer notes, one-click Stripe refund
- Settings: shop name, currency, tax rate, shipping, base URL, Stripe keys

**Under the hood**
- Stock is reserved when an order is placed and released if payment is cancelled, fails, or is not completed within 2 hours
- Sessions in signed HttpOnly cookies, CSRF tokens on every form, scrypt password hashes, login rate limiting, image uploads sniffed by magic bytes (no SVG/HTML uploads), path-traversal-safe static serving

## Quick start

Requires Node.js 22.5+ (24 recommended).

```bash
cd robbins_shop
npm run seed -- --admin-email you@example.com --admin-password change-me   # optional demo data + admin
npm start
```

Open http://localhost:3000. If you skipped the seed, visiting `/admin` the first time asks you to create the admin account.

Add products at http://localhost:3000/admin/products/new. Payments run in test mode until you add Stripe keys.

## Accepting real payments (Stripe)

1. Create a Stripe account and copy your **secret key** from https://dashboard.stripe.com/apikeys (`sk_test_...` for testing, `sk_live_...` for real money).
2. Put it in `.env` (copy `.env.example`) as `STRIPE_SECRET_KEY`, or paste it into **Admin → Settings**.
3. Set `BASE_URL` (or the Settings field) to your public URL, e.g. `https://shop.example.com`. Stripe redirects customers back there after paying.
4. In Stripe → Developers → Webhooks, add an endpoint `https://shop.example.com/webhooks/stripe` with events:
   `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`.
   Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` / Settings.
5. Enable the payment methods you want (Apple Pay, Google Pay, Link, Klarna, Afterpay, bank debits, ...) in Stripe → Settings → Payment methods. Checkout shows them automatically.

For local webhook testing: `stripe listen --forward-to localhost:3000/webhooks/stripe` (Stripe CLI). Test card: `4242 4242 4242 4242`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite database (`shop.db`) and `uploads/` |
| `BASE_URL` | request host | Public URL used for Stripe redirects and image links |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Create the admin account on first start |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | – | Stripe credentials (override Settings) |
| `SESSION_SECRET` | generated | Cookie signing key (otherwise stored in the database) |

Everything else (shop name, currency, tax, shipping) is in **Admin → Settings**.

## Deploying

Any host that runs Node works (a VPS, Railway, Render, Fly.io, a Raspberry Pi). Put it behind HTTPS (Caddy or nginx) and keep `DATA_DIR` on persistent storage; back up `data/` to back up the shop. The app trusts `X-Forwarded-Proto` / `X-Forwarded-Host` from the proxy for URL building and secure cookies.

```bash
PORT=3000 BASE_URL=https://shop.example.com STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... node server.mjs
```

## Development

```bash
npm run dev          # restarts on file changes
npm test             # unit tests + end-to-end smoke test (temp data dir, mocked Stripe)
npm run screenshot   # headless Chrome screenshots into ./screenshots
```

Layout:

```
server.mjs         entry point (.env loading, HTTP server)
src/app.mjs        routes: storefront, cart, checkout, payments, accounts, admin
src/db.mjs         SQLite schema + queries (products, images, cart, orders, users, sessions, settings)
src/stripe.mjs     Stripe REST client (Checkout Sessions, refunds, webhook signature verification)
src/http.mjs       router, cookies, multipart/urlencoded/JSON body parsing
src/auth.mjs       scrypt passwords, HMAC cookie signing, rate limiting
src/cart.mjs       totals, tax, shipping, price parsing
src/render.mjs     HTML layout and components
public/            CSS, JS, placeholder images
scripts/seed.mjs   demo data
test/              node --test unit tests, run-smoke.mjs end-to-end, screenshot.mjs
```

## License

MIT
