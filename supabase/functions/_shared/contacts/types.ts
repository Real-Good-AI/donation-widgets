// Contact provider interface.
//
// A "contact provider" is anything that can add a donor to a mailing list / CRM /
// email-marketing tool after they've opted in. To add your own (Mailchimp, Buttondown,
// Kit, a plain webhook, ...):
//
//   1. Create a file in this folder that exports a ContactProvider (see squarespace.ts).
//   2. Register it in ./index.ts.
//   3. Enable it with the NEWSLETTER_PROVIDERS environment variable.

export interface ContactInfo {
  /** The donor's email, read from the Stripe event. Held in memory only. */
  email: string;
  /** The donor's display name (the name they chose, or their generated one). */
  displayName: string;
}

export interface ContactProvider {
  /** Unique id, used in NEWSLETTER_PROVIDERS (e.g. "squarespace"). Lowercase. */
  id: string;

  /** Return false if required env vars are missing; the provider is then skipped with a warning. */
  isConfigured(): boolean;

  /**
   * Add the contact with marketing consent. Throw on failure — the registry catches and logs
   * errors so a provider problem can never block recording a donation.
   */
  subscribe(contact: ContactInfo): Promise<void>;
}
