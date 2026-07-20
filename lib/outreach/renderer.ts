import type { OutreachEnrollment } from "@/lib/outreach/sequence-types";

/** Simple {{token}} replacement for sequence templates. */
export function renderTemplate(
  template: string,
  enrollment: Pick<
    OutreachEnrollment,
    | "companyName"
    | "domain"
    | "contactName"
    | "contactEmail"
    | "contactLinkedin"
    | "contactRole"
  >,
): string {
  const firstName =
    enrollment.contactName?.trim().split(/\s+/)[0] ??
    enrollment.companyName.split(/\s+/)[0] ??
    "there";

  const vars: Record<string, string> = {
    first_name: firstName,
    full_name: enrollment.contactName?.trim() || firstName,
    company: enrollment.companyName,
    domain: enrollment.domain ?? "",
    role: enrollment.contactRole ?? "",
    email: enrollment.contactEmail ?? "",
    linkedin: enrollment.contactLinkedin ?? "",
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return vars[key] ?? "";
  });
}
