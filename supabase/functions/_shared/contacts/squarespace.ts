// Contact provider: Squarespace Contacts API
//
// Adds the donor as a Squarespace contact with marketing consent
// (primaryEmail.acceptsMarketing: true), putting them in your Email Campaigns audience.
//
// Note: contacts created via the API take effect immediately — there's no confirmation
// email step like Squarespace's own on-site forms have. The opt-in checkbox in the
// donation widget is the only consent captured, so it must stay unchecked by default.
//
// Environment variables:
//   SQUARESPACE_API_KEY    — Squarespace Settings → Advanced → Developer API Keys →
//                            Generate Key, with Contacts permission set to Read & Write
//   SQUARESPACE_USER_AGENT — optional; Squarespace requires a descriptive User-Agent on
//                            every API request, and a default is used if this is unset

import type { ContactInfo, ContactProvider } from "./types.ts";

// The Contacts API requires both a first and last name. We only have a display name, so
// split on the first space. Falls back to a generic label for a blank name.
function splitName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Donor", lastName: "" };
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
}

export const squarespaceProvider: ContactProvider = {
  id: "squarespace",

  isConfigured: () => !!Deno.env.get("SQUARESPACE_API_KEY"),

  async subscribe({ email, displayName }: ContactInfo): Promise<void> {
    const { firstName, lastName } = splitName(displayName);
    const res = await fetch("https://api.squarespace.com/v1/contacts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SQUARESPACE_API_KEY")}`,
        "User-Agent": Deno.env.get("SQUARESPACE_USER_AGENT") ??
          "DonationWidget/1.0 (donation-webhook)",
      },
      body: JSON.stringify({
        firstName,
        lastName,
        locale: "en-US",
        primaryEmail: { email, acceptsMarketing: true },
      }),
    });
    // 409 means the contact already exists — fine, not an error.
    if (!res.ok && res.status !== 409) {
      throw new Error(`Squarespace contact creation failed: ${res.status} ${await res.text()}`);
    }
  },
};
