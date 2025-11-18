import { AuthGate } from "@/components/auth-gate";
import { SeoWorkspace } from "@/components/seo-workspace";

export default function Home() {
  return (
    <AuthGate>
      <SeoWorkspace />
    </AuthGate>
  );
}
