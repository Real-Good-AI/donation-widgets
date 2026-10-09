// Contact provider registry.
//
// stripe-webhook calls subscribeToNewsletter() when a donor has opted in. Which
// provider(s) receive the contact is controlled by the NEWSLETTER_PROVIDERS environment
// variable — a comma-separated list of provider ids, e.g. "squarespace".
// If it's unset, newsletter opt-in is a no-op.
//
// To add a provider, implement ContactProvider (see ./types.ts) and register it below.

import type { ContactInfo, ContactProvider } from "./types.ts";
import { squarespaceProvider } from "./squarespace.ts";

const registry = new Map<string, ContactProvider>();

export function registerContactProvider(provider: ContactProvider): void {
  registry.set(provider.id, provider);
}

// ── Built-in providers ────────────────────────────────────────────────────────
registerContactProvider(squarespaceProvider);

// ── Dispatch ──────────────────────────────────────────────────────────────────

function enabledProviderIds(): string[] {
  return (Deno.env.get("NEWSLETTER_PROVIDERS") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Sends the contact to every enabled provider. Never throws: a newsletter failure must
// never block recording the donation. Providers run in parallel and fail independently.
export async function subscribeToNewsletter(contact: ContactInfo): Promise<void> {
  const ids = enabledProviderIds();
  if (ids.length === 0) {
    console.warn("Newsletter opt-in received but NEWSLETTER_PROVIDERS is not set — skipping");
    return;
  }

  await Promise.all(ids.map(async (id) => {
    const provider = registry.get(id);
    if (!provider) {
      console.warn(`Unknown newsletter provider "${id}" — skipping`);
      return;
    }
    if (!provider.isConfigured()) {
      console.warn(`Newsletter provider "${id}" is enabled but not fully configured — skipping`);
      return;
    }
    try {
      await provider.subscribe(contact);
    } catch (err) {
      console.warn(`Newsletter provider "${id}" failed:`, err);
    }
  }));
}
