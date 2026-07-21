import { redirect } from "next/navigation";

/** Social inbox removed from product IA — keep URL for old bookmarks. */
export default function Page() {
  redirect("/central");
}
