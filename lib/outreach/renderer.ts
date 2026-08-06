import type { OutreachEnrollment } from "@/lib/outreach/sequence-types";
import { deriveSignalTokens } from "@/lib/outreach/template-vars";

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type RenderedTemplate = {
  text: string;
  /** Tokens the template asked for and nothing could fill. */
  missing: string[];
};

type RenderableEnrollment = Pick<
  OutreachEnrollment,
  | "companyName"
  | "domain"
  | "contactName"
  | "contactEmail"
  | "contactLinkedin"
  | "contactRole"
> & { templateVars?: Record<string, string> | null };

/** Every token that has a usable (non-empty) value for this enrollment. */
export function buildTemplateVars(
  enrollment: RenderableEnrollment,
): Record<string, string> {
  const firstName =
    enrollment.contactName?.trim().split(/\s+/)[0] ??
    enrollment.companyName.split(/\s+/)[0] ??
    "there";

  const frozen = enrollment.templateVars ?? {};

  const vars: Record<string, string> = {
    first_name: firstName,
    full_name: enrollment.contactName?.trim() || firstName,
    company: enrollment.companyName,
    domain: enrollment.domain ?? "",
    role: enrollment.contactRole ?? "",
    email: enrollment.contactEmail ?? "",
    linkedin: enrollment.contactLinkedin ?? "",
    // Product-signal values frozen at enrollment time, plus the tokens derived
    // from them now (dates formatted, day counts relative to today).
    ...frozen,
    ...deriveSignalTokens(frozen),
  };

  // An empty value is a hole in the copy, not a value. Dropping it here is what
  // makes it show up as a missing token instead of a blank gap in a sent email.
  return Object.fromEntries(
    Object.entries(vars).filter(([, v]) => typeof v === "string" && v.trim()),
  );
}

/**
 * Render a template, reporting which tokens could not be filled.
 *
 * An unresolved token is left in the text as {{token}} on purpose: the queue
 * card then shows the hole where it is, and the send guard can find it in
 * copy a human edited by hand.
 */
export function renderTemplateParts(
  template: string,
  enrollment: RenderableEnrollment,
): RenderedTemplate {
  const vars = buildTemplateVars(enrollment);
  const missing = new Set<string>();

  const text = template.replace(TOKEN_RE, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      missing.add(key);
      return `{{${key}}}`;
    }
    return value;
  });

  return { text, missing: [...missing] };
}

/** Simple {{token}} replacement for sequence templates. */
export function renderTemplate(
  template: string,
  enrollment: RenderableEnrollment,
): string {
  return renderTemplateParts(template, enrollment).text;
}

/**
 * Tokens still sitting unfilled in already-rendered copy.
 *
 * Works on stored rendered_body/rendered_subject and on text a human edited in
 * the queue, so the send guard needs no extra column to consult.
 */
export function findUnresolvedTokens(
  ...texts: Array<string | null | undefined>
): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(TOKEN_RE)) found.add(match[1]);
  }
  return [...found];
}
