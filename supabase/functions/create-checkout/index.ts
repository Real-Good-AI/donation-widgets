// Supabase Edge Function: create-checkout
// Deploy with: supabase functions deploy create-checkout
//
// IMPORTANT: Add this to supabase/config.toml:
//   [functions.create-checkout]
//   verify_jwt = false
//
// Required environment variables:
//   STRIPE_SECRET_KEY_CHECKOUT — restricted key: Checkout Sessions: Write, Customers: Write
//   SITE_URL                   — your site's URL, e.g. https://www.example.org
//                                (Stripe redirects to /thank-you or /donate on this site
//                                unless you override them below)
//
// Optional environment variables:
//   SUCCESS_URL                 — where Stripe sends donors after paying. Default: SITE_URL/thank-you
//   CANCEL_URL                  — where Stripe sends donors who abandon checkout. Default: SITE_URL/donate
//   ALLOWED_ORIGIN              — origin allowed to call this function from a browser,
//                                 e.g. https://www.example.org. Defaults to "*" (any origin);
//                                 set this in production.
//   ORG_LEGAL_NAME              — your org's legal name, printed on the tax-receipt text
//   ORG_EIN                     — your tax ID, e.g. "12-3456789", printed on the tax-receipt text
//   TAX_RECEIPT_THRESHOLD_CENTS — defaults to 25000 ($250, the IRS threshold for a written
//                                 acknowledgment of charitable contributions in the US —
//                                 confirm the right number with your accountant; this isn't
//                                 tax advice)
//
// Tax receipts:
//   For one-time donations at or above the threshold, this sets
//   payment_intent_data.description on the Checkout Session to a statement containing your
//   org name, EIN, and the "no goods or services were provided" language. Stripe's standard
//   email receipt (free; not a generated invoice) displays this text.
//
//   We deliberately do NOT use Checkout's invoice_creation feature: for one-time payments
//   it's priced separately by Stripe, and a written acknowledgment doesn't require a formal
//   invoice object.
//
//   Recurring donations already get a free Stripe invoice every billing cycle. To make Stripe
//   actually email receipts, enable Dashboard → Settings → Customer emails → Email customers
//   about → "Successful payments".
//
//   The description must be set at session creation — it can't be added to a receipt later.
//
// Newsletter opt-in:
//   This function only forwards the donor's opt-in choice as metadata. The actual
//   contact-provider call happens in stripe-webhook, where the donor's email is
//   available from the completed payment. No email handling happens here.

import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import Stripe from "npm:stripe@22";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY_CHECKOUT")!, {
  apiVersion: "2026-05-27.dahlia",
  httpClient: Stripe.createFetchHttpClient(),
});

const SITE_URL = Deno.env.get("SITE_URL")!;
const SUCCESS_URL = Deno.env.get("SUCCESS_URL") ?? `${SITE_URL}/thank-you`;
const CANCEL_URL = Deno.env.get("CANCEL_URL") ?? `${SITE_URL}/donate`;
const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp", "cad", "aud"];

const ORG_LEGAL_NAME = Deno.env.get("ORG_LEGAL_NAME") ?? "";
const ORG_EIN = Deno.env.get("ORG_EIN") ?? "";
const TAX_RECEIPT_THRESHOLD_CENTS = Number(
  Deno.env.get("TAX_RECEIPT_THRESHOLD_CENTS") ?? "25000",
);

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function taxReceiptStatement(): string {
  const org = ORG_LEGAL_NAME || "our organization";
  const einLine = ORG_EIN ? ` EIN: ${ORG_EIN}.` : "";
  return `Charitable donation receipt. No goods or services were provided in exchange for this contribution. ${org} is a tax-exempt nonprofit organization.${einLine} Please retain this receipt for your tax records.`;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    let body: {
      amount: number;
      currency: string;
      displayName?: string;
      recurring: boolean;
      interval?: "week" | "month" | "year";
      newsletterOptIn?: boolean;
    };

    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }

    // ── Validate ────────────────────────────────────────────────────────────

    const currency = body.currency?.toLowerCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return Response.json({ error: "Unsupported currency" }, { status: 400, headers: corsHeaders });
    }

    const amountCents = Math.round(body.amount * 100);
    if (!amountCents || amountCents < 100) {
      return Response.json({ error: "Minimum donation is 1.00" }, { status: 400, headers: corsHeaders });
    }

    if (body.recurring && !["week", "month", "year"].includes(body.interval ?? "")) {
      return Response.json({ error: "Invalid interval" }, { status: 400, headers: corsHeaders });
    }

    const displayName = body.displayName
      ? body.displayName.replace(/[<>"']/g, "").trim().slice(0, 60)
      : "";

    try {
      // ── Stripe Customer (subscriptions only) ───────────────────────────────
      //
      // Stripe requires a Customer object for subscription mode. For one-time payments
      // we skip this entirely — no customer, no prefill, no privacy issue. The display
      // name and tax receipt text travel via metadata/description instead.

      let customerId: string | undefined;
      if (body.recurring) {
        const customer = await stripe.customers.create(
          displayName ? { name: displayName } : {},
        );
        customerId = customer.id;
      }

      // ── Tax receipt eligibility (one-time donations only) ──────────────────

      const qualifiesForTaxReceipt = !body.recurring && amountCents >= TAX_RECEIPT_THRESHOLD_CENTS;

      // ── Build Checkout Session ─────────────────────────────────────────────

      const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
        currency,
        unit_amount: amountCents,
        product_data: { name: "Donation", description: "Thank you for supporting us!" },
        ...(body.recurring && {
          recurring: { interval: body.interval as "week" | "month" | "year" },
        }),
      };

      const session = await stripe.checkout.sessions.create({
        ...(customerId ? { customer: customerId } : {}),
        mode: body.recurring ? "subscription" : "payment",
        line_items: [{ price_data: priceData, quantity: 1 }],
        // One-time: metadata goes on the PaymentIntent, which Stripe propagates to the
        // Charge, so the charge.updated webhook can read it. The "source" tag lets the
        // webhook ignore charges that didn't come from this widget. description (large
        // gifts only) puts the tax receipt statement on Stripe's standard receipt.
        // Recurring: metadata goes on the subscription; invoices and receipts are already
        // free and automatic every cycle.
        // Metadata values must be strings, hence "true"/"false" for the opt-in flag.
        ...(!body.recurring ? {
          payment_intent_data: {
            ...(qualifiesForTaxReceipt && { description: taxReceiptStatement() }),
            metadata: {
              source: "one_time_donation",
              leaderboard_display_name: displayName,
              newsletter_opt_in: body.newsletterOptIn ? "true" : "false",
            },
          },
        } : {
          subscription_data: {
            metadata: {
              leaderboard_display_name: displayName,
              newsletter_opt_in: body.newsletterOptIn ? "true" : "false",
            },
          },
        }),
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      });

      return Response.json({ url: session.url }, { headers: corsHeaders });
    } catch (err) {
      console.error("Stripe checkout creation failed:", err);
      return Response.json(
        { error: "Something went wrong. Please try again." },
        { status: 500, headers: corsHeaders },
      );
    }
  }),
};
