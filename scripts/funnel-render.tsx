// Renders the funnel diagram to a static HTML file for a visual check without
// logging into the app. Not used in production.
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Diagram } from "@/components/funnel-page";
import { fetchFunnel } from "@/lib/funnel/metrics";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

async function main() {
  const month = process.argv[2] ?? "2026-08";
  const out = process.argv[3] ?? "/tmp/funnel-render.html";
  const data = await fetchFunnel(getSupabaseServiceClient(), month);
  const svg = renderToStaticMarkup(createElement(Diagram, { data, selected: null, onSelect: () => {} }));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{--foreground:#17201c;--muted-foreground:#5d6a63;--card:#fff;--accent:#e2efea;--destructive:#b23a3a;--primary:#0f6e56;--font-mono:ui-monospace}
  body{margin:0;background:#f6f8f5;font-family:-apple-system,Inter,Helvetica,Arial,sans-serif}
  </style></head><body>${svg}</body></html>`;
  writeFileSync(out, html);
  console.log("wrote", out);
}
main().catch((e) => { console.error(e); process.exit(1); });
