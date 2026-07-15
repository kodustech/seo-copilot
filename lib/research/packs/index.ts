import type { PackOutput, Rubric } from "@/lib/research/types";
import { runCareersPack } from "@/lib/research/packs/careers";
import { runProductPack } from "@/lib/research/packs/product";
import { runShipPack } from "@/lib/research/packs/ship";
import { runNewsPack } from "@/lib/research/packs/news";
import { runPainPack } from "@/lib/research/packs/pain";

export type PackName = "careers" | "product" | "ship" | "news" | "pain";

export function packsRequiredByRubric(rubric: Rubric): PackName[] {
  const set = new Set<PackName>();
  for (const c of rubric.criteria) {
    for (const p of c.packs) {
      if (
        p === "careers" ||
        p === "product" ||
        p === "ship" ||
        p === "news" ||
        p === "pain"
      ) {
        set.add(p);
      }
    }
  }
  return [...set];
}

export async function runPacks(input: {
  companyName: string;
  domain: string | null;
  packs: PackName[];
}): Promise<Record<string, PackOutput>> {
  const runners: Record<PackName, () => Promise<PackOutput>> = {
    careers: () =>
      runCareersPack({
        companyName: input.companyName,
        domain: input.domain,
      }),
    product: () => runProductPack({ domain: input.domain }),
    ship: () =>
      runShipPack({ companyName: input.companyName, domain: input.domain }),
    news: () =>
      runNewsPack({ companyName: input.companyName, domain: input.domain }),
    pain: () =>
      runPainPack({ companyName: input.companyName, domain: input.domain }),
  };

  const entries = await Promise.all(
    input.packs.map(async (name) => {
      const out = await runners[name]();
      return [name, out] as const;
    }),
  );

  return Object.fromEntries(entries);
}
