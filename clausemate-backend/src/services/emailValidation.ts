import { config } from "../config";

/**
 * Common disposable / temporary email domains.
 *
 * This list covers the most-abused providers. It is intentionally curated
 * rather than exhaustive — an npm package such as `disposable-email-domains`
 * can be substituted for broader coverage if abuse patterns change.
 *
 * Operators can extend it at runtime via BLOCKED_EMAIL_DOMAINS (comma-separated).
 */
const BUILTIN_BLOCKED_DOMAINS = new Set([
  // Mailinator family
  "mailinator.com", "mailinator2.com", "mailinator2.net",
  // Guerrilla Mail family
  "guerrillamail.com", "guerrillamail.info", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.net", "guerrillamail.org",
  "guerillamail.com", "sharklasers.com",
  // 10 Minute Mail / Temp Mail
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "temp-mail.ru", "temp-mail.de", "tempr.email", "tempm.com",
  "tempmail.ninja", "tmpmail.net", "tmpmail.org", "tempemail.net",
  "temporaryemail.net", "temporaryinbox.com",
  // Trash Mail family
  "trashmail.com", "trashmail.at", "trashmail.io", "trashmail.me",
  "trashmail.net", "trashmail.org", "trashmail.xyz", "trashmailer.com",
  "trashymail.com", "trash-mail.com", "trash-mail.at",
  // Yop Mail family
  "yopmail.com", "yopmail.fr",
  // Maildrop / Discard
  "maildrop.cc", "discard.email", "dispostable.com", "discardmail.com",
  "discardmail.de",
  // Spam prevention services used as throwaway addresses
  "spamgourmet.com", "spamgourmet.net", "spamgourmet.org",
  "spambob.com", "spambob.net", "spambob.org",
  "spamhole.com", "spamspot.com", "spamfree.eu", "spaml.com", "spaml.de",
  "spambox.info", "spambox.org", "spambox.us",
  // Fake Inbox / Fake Email
  "fakeinbox.com", "fakeinbox.net", "fakemailgenerator.com",
  "emailfake.com", "fakedemail.com",
  // Other well-known services
  "throwaway.email", "throwam.com", "throam.com",
  "mailnull.com", "mailnesia.com", "mailcatch.com", "mailexpire.com",
  "maileater.com", "mailbidon.com",
  "getairmail.com", "getnada.com", "getonemail.net",
  "anonbox.net", "rcpt.at",
  "selfdestructingmail.com", "killmail.com", "killmail.net",
  "sneakemail.com", "snkmail.com",
  "sofortmail.de", "sofort-mail.de",
  "tmail.com", "tmail.io",
  "mytemp.email", "mytempemail.com", "mytempmail.com",
  "owlpic.com", "gufum.com",
  "spam4.me", "spam.la", "spam.su", "spam.lol",
  "crap.ninja",
  "mintemail.com",
  "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org",
  "wegwerfemail.com", "wegwerfemail.de",
  "schrott-email.de", "schwarzmail.de",
  "despam.it",
  "nospam.ze.tc",
  "bspamfree.org",
]);

/**
 * Returns true if the email address belongs to a known disposable or
 * blocked email domain.
 *
 * The check is domain-level only — it does not validate DNS or MX records.
 * Case-insensitive.
 */
export function isDisposableEmail(email: string): boolean {
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return false;

  const domain = email.slice(atIdx + 1).toLowerCase();
  if (!domain) return false;

  if (BUILTIN_BLOCKED_DOMAINS.has(domain)) return true;

  // Operator-configured extra domains
  const extra = config.auth.blockedEmailDomains;
  if (extra) {
    for (const blocked of extra.split(",")) {
      if (blocked.trim().toLowerCase() === domain) return true;
    }
  }

  return false;
}
