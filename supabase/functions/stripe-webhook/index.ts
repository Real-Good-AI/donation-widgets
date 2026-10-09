// Supabase Edge Function: stripe-webhook
// Deploy with: supabase functions deploy stripe-webhook
//
// IMPORTANT: Add this to supabase/config.toml:
//   [functions.stripe-webhook]
//   verify_jwt = false
//
// Handles:
//   charge.updated               — one-time donation (balance_transaction attached)
//   invoice.payment_succeeded    — each recurring billing cycle
//   charge.refunded              — full or partial refund
//
// Currency handling:
//   Each donation stores both the original amount/currency (what the donor chose)
//   and the USD equivalent at time of payment. The USD figure comes from Stripe's
//   own balance transaction — the settled amount in your account currency — so no
//   external exchange rate API is needed. (This assumes a USD-settling Stripe account.)
//
//   For partial refunds, both figures are scaled proportionally to the kept fraction.
//
// Anonymous donors get a generated fun name (e.g. "Resplendent Capybara").
// For recurring subscriptions the name is persisted to subscription metadata so
// every future billing cycle gets the same name.
//
// Newsletter opt-in:
//   When a donor checks "Sign me up for the newsletter" (opt-in, unchecked by default),
//   the donor's email — taken directly from the Stripe event, never written to Supabase —
//   is handed to the contact-provider registry in ../_shared/contacts. Which provider(s)
//   receive it is set by NEWSLETTER_PROVIDERS (see that folder to add your own).
//   For recurring donations this only fires on the subscription's first invoice
//   (billing_reason === "subscription_create") so donors aren't re-subscribed every
//   billing cycle. A failure here never blocks recording the donation — it's logged
//   and swallowed.
//
// Required environment variables:
//   STRIPE_SECRET_KEY_WEBHOOK — restricted key: Charges: Read, Balance Transactions: Read,
//                               Invoices: Read, PaymentIntents: Read, Subscriptions: Write
//   STRIPE_WEBHOOK_SECRET     — Stripe Dashboard → Webhooks → your endpoint → Signing secret
//
// Optional environment variables:
//   NEWSLETTER_PROVIDERS      — comma-separated provider ids to enable, e.g. "squarespace".
//                               If unset, newsletter opt-in is skipped. Each provider has
//                               its own variables; see ../_shared/contacts/<provider>.ts.

import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@22";
import { randomSuperbWord } from "npm:superb@5";
import { subscribeToNewsletter } from "../_shared/contacts/index.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY_WEBHOOK")!, {
  apiVersion: "2026-05-27.dahlia",
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SUPABASE_SECRET_KEYS["default"],
);

// ── Anonymous name generation ─────────────────────────────────────────────────

const ANIMALS = [
  "Axolotl", "Binturong", "Capybara", "Caracal", "Fennec",
  "Fossa", "Kinkajou", "Meerkat", "Narwhal", "Numbat",
  "Okapi", "Pangolin", "Platypus", "Quokka", "Tapir",
  "Tarsier", "Wombat", "Quoll", "Saiga", "Tamandua",
];

function anonymousName(): string {
  const adj = randomSuperbWord();
  const capitalized = adj.charAt(0).toUpperCase() + adj.slice(1);
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${capitalized} ${animal}`;
}

function resolveName(raw: string | null | undefined): string {
  return raw?.trim() || anonymousName();
}

// For recurring donations: persists the generated name back to subscription
// metadata so every future billing cycle gets the same name.
async function resolveRecurringName(
  subscriptionId: string,
  subscription: Stripe.Subscription,
): Promise<string> {
  const existing = subscription.metadata?.leaderboard_display_name?.trim();
  if (existing) return existing;
  const funName = anonymousName();
  await stripe.subscriptions.update(subscriptionId, {
    metadata: { leaderboard_display_name: funName },
  });
  return funName;
}

// ── Currency helpers ──────────────────────────────────────────────────────────

// Looks up the USD equivalent of a payment via the Charges API.
// balance_transaction.amount is always in the Stripe account's settlement
// currency (USD for US accounts), so this is the authoritative conversion
// with no external API needed.
//
// Note: latest_charge was removed from the PaymentIntent object in a recent
// Stripe API version, so we use stripe.charges.list() instead of expanding
// latest_charge directly on the PaymentIntent.
//
// Falls back to fallbackCents (the original currency amount) if no balance
// transaction is found — this can happen in test mode for same-currency
// payments where Stripe skips creating a conversion record.
async function getAmountUSD(
  paymentIntentId: string,
  fallbackCents: number,
): Promise<number> {
  try {
    const charges = await stripe.charges.list({
      payment_intent: paymentIntentId,
      limit: 1,
      expand: ["data.balance_transaction"],
    });
    const balanceTx = charges.data[0]?.balance_transaction as Stripe.BalanceTransaction | null;
    if (balanceTx?.amount) return balanceTx.amount / 100;
  } catch (err) {
    console.warn("Could not fetch balance transaction for", paymentIntentId, err);
  }
  return fallbackCents / 100;
}

// ── Webhook handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Read raw body FIRST — Stripe's signature check hashes this exact byte sequence.
  const body = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (err) {
    console.error("Stripe signature verification failed:", err);
    return new Response("bad signature", { status: 400 });
  }

  // ── One-time donation ─────────────────────────────────────────────────────
  //
  // We listen to charge.updated rather than payment_intent.succeeded because
  // with capture_method: automatic_async, Stripe attaches the balance_transaction
  // to the charge asynchronously — a few seconds after the PI succeeds.
  // charge.updated fires with previous_attributes.balance_transaction === null
  // at the exact moment the balance_transaction is set, giving us the correct
  // settled USD amount. Stripe propagates payment_intent_data.metadata to the
  // charge, so our source tag and display name are available here directly.
  if (event.type === "charge.updated") {
    const charge = event.data.object;
    const prev = event.data.previous_attributes as Partial<Stripe.Charge> | undefined;

    // Only process when:
    //   1. tagged as a one-time donation from our widget
    //   2. balance_transaction just transitioned from null → a value
    //      (prev.balance_transaction === null means it was null before this update;
    //       if it's undefined, it wasn't part of the diff, meaning it didn't change)
    if (
      charge.metadata?.source !== "one_time_donation" ||
      prev?.balance_transaction !== null ||
      !charge.balance_transaction
    ) {
      return Response.json({ received: true });
    }

    // balance_transaction.amount is always in the account's settlement currency
    // (USD for US accounts) — the authoritative converted figure.
    const balanceTx = await stripe.balanceTransactions.retrieve(
      charge.balance_transaction as string,
    );

    const name = resolveName(charge.metadata?.leaderboard_display_name);
    const originalAmount = charge.amount / 100;
    const originalCurrency = charge.currency;
    const amountUSD = balanceTx.amount / 100;

    const { error } = await db.from("donations").insert({
      stripe_payment_intent_id: charge.payment_intent as string,
      name,
      original_amount: originalAmount,
      original_currency: originalCurrency,
      amount_usd: amountUSD,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("DB insert failed (one-time):", error);
      return new Response("DB error", { status: 500 });
    }
    console.log(`One-time: ${originalCurrency.toUpperCase()} ${originalAmount} (≈ USD ${amountUSD}) — "${name}"`);

    if (charge.metadata?.newsletter_opt_in === "true") {
      const email = charge.billing_details?.email;
      if (email) {
        await subscribeToNewsletter({ email, displayName: name });
      } else {
        console.warn("newsletter_opt_in was true but no email on charge:", charge.id);
      }
    }
  }

  // ── Recurring payment ─────────────────────────────────────────────────────
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const parent = invoice.parent;

    if (parent?.type !== "subscription_details") {
      return Response.json({ received: true });
    }

    const subscriptionId = parent.subscription_details?.subscription;
    if (!subscriptionId || typeof subscriptionId !== "string") {
      console.error("Could not resolve subscription ID for invoice:", invoice.id);
      return new Response("Missing subscription ID", { status: 500 });
    }

    // invoice.payment_intent was removed in API version 2025-03-31.basil;
    // it's now accessed via payments.data.payment.payment_intent.
    const invoiceWithPayments = await stripe.invoices.retrieve(invoice.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    const firstPayment = invoiceWithPayments.payments?.data?.[0];
    if (firstPayment?.payment?.type !== "payment_intent") {
      console.error("Unexpected payment type for invoice:", invoice.id);
      return new Response("Unexpected payment type", { status: 500 });
    }

    const pi = firstPayment.payment.payment_intent as Stripe.PaymentIntent;
    const originalAmount = (invoice.amount_paid ?? 0) / 100;
    const originalCurrency = invoice.currency ?? "usd";
    const amountUSD = await getAmountUSD(pi.id, invoice.amount_paid ?? 0);

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const name = await resolveRecurringName(subscriptionId, subscription);

    const { error } = await db.from("donations").insert({
      stripe_payment_intent_id: pi.id,
      stripe_subscription_id: subscriptionId,
      name,
      original_amount: originalAmount,
      original_currency: originalCurrency,
      amount_usd: amountUSD,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("DB insert failed (recurring):", error);
      return new Response("DB error", { status: 500 });
    }
    console.log(`Recurring: ${originalCurrency.toUpperCase()} ${originalAmount} (≈ USD ${amountUSD}) — "${name}"`);

    // Only subscribe on the subscription's first invoice, so donors aren't
    // re-subscribed on every billing cycle.
    if (
      subscription.metadata?.newsletter_opt_in === "true" &&
      invoice.billing_reason === "subscription_create"
    ) {
      const email = invoice.customer_email;
      if (email) {
        await subscribeToNewsletter({ email, displayName: name });
      } else {
        console.warn("newsletter_opt_in was true but no email on invoice:", invoice.id);
      }
    }
  }

  // ── Refund ────────────────────────────────────────────────────────────────
  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const paymentIntentId = charge.payment_intent as string;
    const isFullRefund = charge.amount_refunded === charge.amount;

    if (isFullRefund) {
      const { error } = await db
        .from("donations")
        .delete()
        .eq("stripe_payment_intent_id", paymentIntentId);
      if (error) console.error("Delete failed:", error);
      else console.log(`Full refund — removed: ${paymentIntentId}`);
    } else {
      // Scale both original_amount and amount_usd by the fraction of the charge
      // that was kept. This avoids a second Stripe API call and is accurate
      // because the FX rate is already baked into the stored amount_usd.
      const keptFraction = (charge.amount - charge.amount_refunded) / charge.amount;

      const { data: existing, error: fetchError } = await db
        .from("donations")
        .select("original_amount, amount_usd")
        .eq("stripe_payment_intent_id", paymentIntentId)
        .single();

      if (fetchError || !existing) {
        console.error("Could not find row for partial refund:", paymentIntentId);
        return new Response("Row not found", { status: 500 });
      }

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const { error } = await db
        .from("donations")
        .update({
          original_amount: round2(existing.original_amount * keptFraction),
          amount_usd: round2(existing.amount_usd * keptFraction),
        })
        .eq("stripe_payment_intent_id", paymentIntentId);

      if (error) console.error("Partial refund update failed:", error);
      else console.log(`Partial refund — kept ${Math.round(keptFraction * 100)}% of ${paymentIntentId}`);
    }
  }

  return Response.json({ received: true });
});
