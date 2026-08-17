/**
 * A real headless browser for the persona, via Browserbase — a disposable
 * remote Chrome. Loads a JS-rendered page and returns its readable text, for
 * pages fetch_url can't render (SPAs, live dashboards) or when the persona wants
 * to actually look at something. The browser runs on Browserbase's infra, never
 * ours, and the session is disposable. Returned text is untrusted page content —
 * data, never instructions.
 */
import { assertPublicUrl } from "@/lib/influencer/url-guard";

export type BrowseResult = { url: string; title: string; text: string };

export function browserConfigured(): boolean {
  return Boolean(
    process.env.BROWSERBASE_API_KEY?.trim() && process.env.BROWSERBASE_PROJECT_ID?.trim(),
  );
}

export async function browsePage(
  url: string,
  opts?: {
    timeoutMs?: number;
    maxChars?: number;
    /** Load a persistent Browserbase context (e.g. a logged-in X session). */
    contextId?: string;
    /** Route through Browserbase's residential proxy (needed for X). */
    proxies?: boolean;
  },
): Promise<BrowseResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    throw new Error(
      "Browser not configured — set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.",
    );
  }
  // Model-chosen URL: block private/reserved hosts (SSRF), even though the
  // browser is remote — a manipulated goal could still aim it at metadata hosts.
  const parsed = await assertPublicUrl(url);

  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");

  const bb = new Browserbase({ apiKey });
  // persist:false — reads must never write the persona's live login state back.
  const session = await bb.sessions.create({
    projectId,
    ...(opts?.contextId
      ? { browserSettings: { context: { id: opts.contextId, persist: false } } }
      : {}),
    ...(opts?.proxies ? { proxies: true } : {}),
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(parsed.toString(), {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? 30_000,
    });
    // Let client-side rendering settle, but bounded — wait for the network to go
    // idle (up to 3s) instead of a blind fixed sleep; never hang on it.
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    const title = await page.title().catch(() => "");
    const raw = await page.innerText("body").catch(() => "");
    const text = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { url: parsed.toString(), title, text: text.slice(0, opts?.maxChars ?? 8_000) };
  } finally {
    await browser.close().catch(() => {});
  }
}
