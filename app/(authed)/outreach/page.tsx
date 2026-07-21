import { redirect } from "next/navigation";

/**
 * Pipeline board removed from product IA.
 * Convert system of record is Accounts (/crm).
 */
export default function Page() {
  redirect("/crm");
}
