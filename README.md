# Donation system and widgets

A self-hosted donation system built on **Stripe** (payments), **Supabase** (database + serverless functions), and three embeddable widgets: a donation form, a live leaderboard, and a recent-donations feed. The widgets are plain HTML/JS, so they work anywhere you can embed custom HTML: Squarespace, WordPress, Webflow, Wix, a static site, and so on.

- No monthly platform fees. You pay only Stripe's per-transaction processing fees (nonprofits may qualify for a discounted rate).
- No donor emails or other personal data stored in your database.
- One-time and recurring gifts, multiple currencies, anonymous donors, refunds, optional newsletter sign-up (via pluggable contact providers), and optional tax-receipt text for large gifts.
- Live updates via Supabase Realtime, with no page refresh.

> **Not tax or legal advice.** The receipt text and thresholds described here are a starting point. Confirm them with your accountant.

---

## How it works

```
Donor fills in the donation widget (embedded on your site)
        │  HTTPS POST
        ▼
Supabase Edge Function: create-checkout
  • Validates input, creates a Stripe Checkout Session
        │  redirect
        ▼
Stripe Checkout (hosted by Stripe: card entry, 3DS, receipts)
        │  webhook
        ▼
Supabase Edge Function: stripe-webhook
  • Verifies the Stripe signature
  • Assigns a generated name to anonymous donors ("Resplendent Capybara")
  • Records one-time payments and each recurring billing cycle
  • Handles full and partial refunds
  • Optionally subscribes the donor to your newsletter (pluggable providers)
        │
        ▼
Supabase Postgres  (donations table: one row per payment)
        │  RPC + Realtime
        ▼
Leaderboard and recent-donations widgets (embedded on your site)
```

### Design decisions

- **One row per payment.** Each one-time gift and each recurring billing cycle gets its own row, so refunds are a simple delete or update and history is preserved.
- **One-time and recurring gifts rank differently.** One-time gifts appear as individual entries. Recurring gifts are summed per subscription, so a $20/month donor shows as $240 on the 1-year view. A Postgres function (`leaderboard_rankings`) does this; the widget calls it instead of querying the table.
- **Anonymous donors get a stable generated name.** The name is stored with the donation. For subscriptions it is also saved to the Stripe subscription's metadata so every future billing cycle reuses it.
- **No donor deduplication.** Guest checkouts have no stable identity, so a one-time donor who gives twice appears twice. Recurring donors are consolidated within their subscription.
- **Multi-currency.** Each row stores the original amount and currency plus the USD equivalent, taken from Stripe's balance transaction (the actual settled amount), so no exchange-rate API is needed. The leaderboard ranks by USD and shows the original currency as the primary figure.
- **Receipts stay in Stripe.** Donor emails and receipts never pass through your database.

---

## Prerequisites

- A [Stripe](https://stripe.com) account
- A [Supabase](https://supabase.com) project (the free tier is sufficient for most small organizations)
- A website where you can embed custom HTML/JS (e.g. a code block or HTML widget; some site builders require a paid plan for this)
- [Node.js](https://nodejs.org) and the [Supabase CLI](https://supabase.com/docs/guides/cli): `npm install -g supabase`
- *Optional:* an account with a supported newsletter/contact provider (currently Squarespace only; see [Newsletter opt-in](#newsletter-opt-in))

---

## Repository layout

```
scripts/
  deploy.sh                       # db push + secrets upload + functions deploy
supabase/
  config.toml                     # project id; verify_jwt = false for both functions
  migrations/
    20261008000000_init_donations.sql   # table, ranking function, RLS, grants, Realtime
  functions/
    .env.example                  # copy to .env and fill in; uploaded as secrets
    create-checkout/index.ts      # Creates Stripe Checkout Sessions
    stripe-webhook/index.ts       # Records donations, names, refunds, newsletter
    _shared/contacts/             # Newsletter contact-provider registry
      index.ts                    #   registry + dispatch
      types.ts                    #   ContactProvider interface
      squarespace.ts              #   built-in provider
widgets/
  donation-widget.html            # Donation form
  leaderboard.html                # Top supporters, with timeframe selector
  recent-donations.html           # Latest gifts feed
```

---

## Setup

The whole backend (database, functions, secrets) is deployed from the command line with the Supabase CLI. You'll create two accounts, fill in one env file, and run one script.

### 1. Stripe

1. Create a Stripe account.
2. *Optional, US nonprofits:* apply for the nonprofit processing discount at `dashboard.stripe.com/settings/nonprofit` (requires your IRS determination letter). Check Stripe's pricing page for current rates.
3. Create two restricted API keys (test mode first); see [Restricted API keys](#restricted-api-keys) below.

### 2. Supabase project

1. Create a new project at supabase.com and note your database password and **project ref** (the id in your dashboard URL: `supabase.com/dashboard/project/<project-ref>`).
2. Link this repo to it:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

### 3. Configure secrets

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

Fill in `supabase/functions/.env`. Required: the two Stripe keys and `SITE_URL`. Everything else is optional; see the comments in the file or the table below. Leave `STRIPE_WEBHOOK_SECRET` commented out for now. You get it in step 5.

`.env` is git-ignored. Keep test-mode and live-mode values in separate files (e.g. `.env` and `.env.live`), because Stripe issues separate keys and webhook secrets for each mode.

| Variable | Value | Used by |
|---|---|---|
| `STRIPE_SECRET_KEY_CHECKOUT` | Restricted key for checkout (see below) | `create-checkout` |
| `STRIPE_SECRET_KEY_WEBHOOK` | Restricted key for the webhook (see below) | `stripe-webhook` |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) from your Stripe webhook endpoint (step 5) | `stripe-webhook` |
| `SITE_URL` | Your site's URL, e.g. `https://www.example.org` | `create-checkout` |
| `SUCCESS_URL` | *Optional.* Where donors land after paying. Defaults to `SITE_URL/thank-you` | `create-checkout` |
| `CANCEL_URL` | *Optional.* Where donors land if they abandon checkout. Defaults to `SITE_URL/donate` | `create-checkout` |
| `ALLOWED_ORIGIN` | *Optional but recommended.* Your site's origin, e.g. `https://www.example.org`. Defaults to `*` | `create-checkout` |
| `ORG_LEGAL_NAME` | *Optional.* Legal name printed on tax-receipt text | `create-checkout` |
| `ORG_EIN` | *Optional.* Tax ID printed on tax-receipt text, e.g. `12-3456789` | `create-checkout` |
| `TAX_RECEIPT_THRESHOLD_CENTS` | *Optional.* Defaults to `25000` ($250) | `create-checkout` |
| `NEWSLETTER_PROVIDERS` | *Optional.* Comma-separated provider ids that receive opted-in donors, e.g. `squarespace`. Unset = newsletter opt-in disabled | `stripe-webhook` |
| *(provider-specific)* | Each provider has its own variables; see [Newsletter opt-in](#newsletter-opt-in) | `stripe-webhook` |

Don't put `SUPABASE_*` variables in this file. Supabase injects `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` automatically. Secrets are shared across the whole project, which is why the two Stripe keys have different variable names.

#### Restricted API keys

Each function gets its own restricted key (`rk_test_...` / `rk_live_...`), scoped to only what it calls, so a leak of one key has limited impact. Create them in **Stripe Dashboard → Developers → API keys → Create restricted key**. Everything not listed should be **None**.

**`STRIPE_SECRET_KEY_CHECKOUT`**

| Resource | Permission | Why |
|---|---|---|
| Checkout Sessions | Write | Creates the hosted checkout session |
| Customers | Write | Creates a Customer for recurring donations only |

**`STRIPE_SECRET_KEY_WEBHOOK`**

| Resource | Permission | Why |
|---|---|---|
| Charges | Read | Reads the charge to find the settled USD amount |
| Balance transactions (sources) | Read | Needed to expand `balance_transaction` |
| Invoices | Read | Reads each recurring billing cycle's invoice |
| PaymentIntents | Read | Expanded from the invoice's payment |
| Subscriptions | Write | Reads subscription metadata and saves the generated donor name |

The webhook key does not need Refunds permission. The webhook only reacts to refunds you issue in the Dashboard.

> Tip: if you are unsure what a function calls, check the request logs of an unrestricted key in the Stripe Dashboard and match each endpoint to a permission.

### 4. Deploy

```bash
./scripts/deploy.sh
```

This runs three commands (run them yourself if you prefer):

| Command | What it does |
|---|---|
| `supabase db push` | Applies everything in `supabase/migrations/` to your project: the `donations` table, the `leaderboard_rankings()` function, Row Level Security, grants, and Realtime. |
| `supabase secrets set --env-file supabase/functions/.env` | Uploads every variable in your env file as an Edge Function secret. |
| `supabase functions deploy` | Deploys both functions. `verify_jwt = false` is applied from `supabase/config.toml`. |

To deploy with live-mode values later: `./scripts/deploy.sh supabase/functions/.env.live`.

You don't need to change any Supabase dashboard settings. The migration enables RLS and states its grants explicitly, so it works whether or not your project auto-exposes new tables.

### 5. Connect Stripe to Supabase

1. In Stripe: **Developers → Webhooks → Add endpoint**.
2. URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook`
3. Use the same API version the Edge Functions pin (`2026-05-27.dahlia`). Stripe sends webhook payloads in the endpoint's version, so a mismatch can change the payload shapes the code expects.
4. Select these events:
   - `charge.updated`: one-time donations. Fires when Stripe attaches the balance transaction, which is when the settled USD amount becomes available.
   - `invoice.payment_succeeded`: each recurring billing cycle
   - `charge.refunded`: refunds
5. Copy the endpoint's **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` in your env file, then upload it:

   ```bash
   supabase secrets set --env-file supabase/functions/.env
   ```

   (Re-running `./scripts/deploy.sh` also works.)

### 6. Embed the widgets

Each widget is a single, self-contained HTML file. Paste its contents into any place your site allows custom HTML/JS (for example, a Squarespace Code Block, a WordPress Custom HTML block, or a Webflow Embed).

| Widget | Placeholders to replace |
|---|---|
| `donation-widget.html` | `{{SUPABASE_URL}}` |
| `leaderboard.html` | `{{SUPABASE_URL}}`, `{{SUPABASE_PUBLISHABLE_KEY}}` |
| `recent-donations.html` | `{{SUPABASE_URL}}`, `{{SUPABASE_PUBLISHABLE_KEY}}` |

Your **publishable key** (`sb_publishable_...`) is safe to expose in page source. Your **secret key** must never appear in frontend code.

The donation widget has a small CONFIG section at the top of its script. Set `SHOW_NEWSLETTER_OPT_IN = false` to hide the newsletter checkbox if you haven't enabled a provider.

Also create two pages on your site (or point `SUCCESS_URL` / `CANCEL_URL` elsewhere):

- `/thank-you`: where Stripe redirects after payment
- `/donate`: where donors land if they cancel checkout

### 7. Test it

1. Switch Stripe to **test mode** and use test-mode keys and webhook secret.
2. Complete a real test checkout with card `4242 4242 4242 4242`, any future expiry, any CVC.
3. In **Supabase → Table Editor → donations**, a row should appear within a couple of seconds with a name filled in.

> Stripe's "Send test webhook" button sends a synthetic event with empty metadata. It's useful for checking signature verification but won't produce a realistic row.

---

## Optional features

### Tax receipts for large gifts

One-time gifts at or above a threshold (default $250, which matches the IRS threshold for a written acknowledgment of charitable contributions in the US) get custom text added to Stripe's standard email receipt: your organization's name, EIN, and a "no goods or services were provided" statement. Gifts below the threshold get the normal receipt without that text. Recurring gifts already generate a Stripe invoice each cycle.

Setup:

1. Set `ORG_LEGAL_NAME`, `ORG_EIN`, and optionally `TAX_RECEIPT_THRESHOLD_CENTS` in your env file and re-run `./scripts/deploy.sh`.
2. In Stripe: **Settings → Customer emails → Email customers about → Successful payments**. Without this, Stripe won't send receipts at all.
3. Test with a donation above and below the threshold and compare the emails.

This deliberately avoids Checkout's `invoice_creation` feature, which Stripe prices separately for one-time payments, and instead uses `payment_intent_data.description` on the free standard receipt.

### Newsletter opt-in

The donation form shows an **unchecked** "Sign me up for the newsletter" checkbox. If checked, the choice travels as Stripe metadata, and `stripe-webhook` passes the donor's email (read from the Stripe event) to the **contact providers** you've enabled. The email is held in memory for that call and never written to the database.

Providers are pluggable. Set `NEWSLETTER_PROVIDERS` to a comma-separated list of provider ids (for example `squarespace`). If it's unset, opt-in is a no-op, and you should set `SHOW_NEWSLETTER_OPT_IN = false` in the donation widget so the checkbox doesn't appear.

**Available providers**

| Id | Service | Variables |
|---|---|---|
| `squarespace` | Squarespace Contacts API (adds the donor to your Email Campaigns audience) | `SQUARESPACE_API_KEY`, optional `SQUARESPACE_USER_AGENT` |

Squarespace is currently the only implemented provider. To set it up:

1. In Squarespace: **Settings → Advanced → Developer API Keys → Generate Key**, with **Contacts: Read & Write**. The key is shown only once.
2. Add `SQUARESPACE_API_KEY` and `NEWSLETTER_PROVIDERS=squarespace` to your env file and re-run `./scripts/deploy.sh`.
3. Test with the checkbox checked, then look for the new contact in Squarespace's **Contacts** panel.

**Adding a provider**

1. Create `supabase/functions/_shared/contacts/<name>.ts` exporting a `ContactProvider` (see `types.ts`):

   ```ts
   import type { ContactProvider } from "./types.ts";

   export const exampleProvider: ContactProvider = {
     id: "example",
     isConfigured: () => !!Deno.env.get("EXAMPLE_API_KEY"),
     async subscribe({ email, displayName }) {
       const res = await fetch("https://api.example.com/subscribers", {
         method: "POST",
         headers: { Authorization: `Bearer ${Deno.env.get("EXAMPLE_API_KEY")}` },
         body: JSON.stringify({ email, name: displayName }),
       });
       if (!res.ok) throw new Error(`Example API failed: ${res.status}`);
     },
   };
   ```

2. Register it in `_shared/contacts/index.ts` with `registerContactProvider(exampleProvider)`.
3. Add `NEWSLETTER_PROVIDERS=example` (or `squarespace,example` to use several) and `EXAMPLE_API_KEY` to your env file, then re-run `./scripts/deploy.sh`.

Providers should throw on failure; the registry logs the error and moves on, so a provider problem can never block recording a donation. Pull requests adding providers are welcome.

**Things to know**

- The checkbox is the only consent captured. Some providers (including Squarespace's API) subscribe contacts immediately with no confirmation email, so keep it unchecked by default.
- Providers receive only an email and a display name. A provider that needs more (such as separate first and last names) must work that out itself; the Squarespace provider splits the display name on the first space.
- For subscriptions, the call fires only on the first invoice.
- Consider the email-marketing rules that apply to your donors (e.g. CAN-SPAM, GDPR).

---

## Refunds

Handled by `stripe-webhook` on `charge.refunded`:

- **Full refund:** the row is deleted and the entry leaves the leaderboard.
- **Partial refund:** the row's original and USD amounts are scaled to the fraction kept.

---

## Security

- Stripe webhook signature is verified on every request, using the raw request body.
- Separate restricted Stripe keys per function.
- Row Level Security: browsers can read the `donations` table but never write to it.
- Donor-supplied names are HTML-escaped before rendering.
- Amount, currency, and interval are validated server-side.
- Checkout does not search for or reuse Stripe customers, so one donor's details are never prefilled for another.
- No emails, IP addresses, or Stripe Customer IDs are stored in your database.
- Stripe metadata is never trusted for anything beyond display name, newsletter choice, and the source tag.

**Hardening before production:**

- `create-checkout` allows any origin by default. Set `ALLOWED_ORIGIN` to your site's origin (include `https://`, and match `www` exactly).
- Display names are user-supplied and public. Consider adding profanity filtering or moderation.
- The 500K invocation/month and bandwidth limits on Supabase's free tier are generous, but check current limits.

---

## Costs

| Service | Cost |
|---|---|
| Supabase | Free tier covers small deployments; see their pricing for limits |
| Stripe | Per-transaction fees only (standard or nonprofit rate; see Stripe's pricing page) |
| Your website host | Your existing plan |

---

## Limitations

- One-time donors are not deduplicated across gifts.
- Supported currencies are fixed in `create-checkout` (`usd`, `eur`, `gbp`, `cad`, `aud`). Edit `SUPPORTED_CURRENCIES` and the widget's currency buttons to change them.
- The USD figure depends on your Stripe account's settlement currency; the code assumes USD.
- The widgets are plain HTML/JS with no build step. They need a host that allows custom HTML/JS, and they load the Supabase client from a CDN (`esm.sh`).

---

## Contributing

Issues and pull requests are welcome. Please do not include real API keys, webhook secrets, or donor data in issues or PRs.

## AI usage disclosure

[![REAL Rating 4: Major AI](REAL_rating_4.png)][REAL rating]

While pieces of the code in this project have been almost entirely generated, it still required a lot of time and effort in the form of exploration, decision making, testing, debugging, and iterating, so it's rated **REAL Rating 4: Major AI**. We hope it will help you save on fees and get the most out your donations.

→ [Learn more about the REAL rating][REAL rating]

[REAL rating]: https://www.realgoodai.org/real-rating

## License

MIT. See [LICENSE](LICENSE).
