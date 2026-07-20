import { Suspense } from "react";

import { ResearchPage } from "@/components/research-page";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
          Loading lists…
        </div>
      }
    >
      <ResearchPage />
    </Suspense>
  );
}
