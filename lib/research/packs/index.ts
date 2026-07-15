import type { PackOutput, Rubric } from "@/lib/research/types";
import { runCareersPack } from "@/lib/research/packs/careers";
import { runProductPack } from "@/lib/research/packs/product";
import { runShipPack } from "@/lib/research/packs/ship";
import { runNewsPack } from "@/lib/research/packs/news";
import { runPainPack } from "@/lib/research/packs/pain";
import { runFirmoPack } from "@/lib/research/packs/firmo";

export type PackName =
  | "careers"
  | "product"
  | "ship"
  | "news"
  | "pain"
  | "firmo";

const PACK_NAMES = new Set<PackName>([
  "careers",
  "product",
  "ship",
  "news",
  "pain",
  "firmo",
]);

export function packsRequiredByRubric(rubric: Rubric): PackName[] {
  const set = new Set<PackName>();
  for (const c of rubric.criteria) {
    for (const p of c.packs) {
      if (PACK_NAMES.has(p as PackName)) set.add(p as PackName);
    }
  }
  return [...set];
}

export async function runPacks(input: {
  companyName: string;
  domain: string | null;
  packs: PackName[];
  knownBoard?: { ats: string; slug: string } | null;
}): Promise<Record<string, PackOutput>> {
  const runners: Record<PackName, () => Promise<PackOutput>> = {
    careers: () =>
      runCareersPack({
        companyName: input.companyName,
        domain: input.domain,
        knownBoard: input.knownBoard,
      }),
    product: () => runProductPack({ domain: input.domain }),
    ship: () =>
      runShipPack({ companyName: input.companyName, domain: input.domain }),
    news: () =>
      runNewsPack({ companyName: input.companyName, domain: input.domain }),
    pain: () =>
      runPainPack({ companyName: input.companyName, domain: input.domain }),
    firmo: () =>
      runFirmoPack({ companyName: input.companyName, domain: input.domain }),
  };

  const entries = await Promise.all(
    input.packs.map(async (name) => {
      const out = await runners[name]();
      return [name, out] as const;
    }),
  );

  return Object.fromEntries(entries);
}
