// ALLOWED_EMAILS: the Google accounts that may use the app (spec "Security & privacy", Google verification).

export function allowedEmails(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(raw: string, email: string): boolean {
  return allowedEmails(raw).has(email.trim().toLowerCase());
}
