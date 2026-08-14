/**
 * A real headless browser for the persona, via Browserbase — a disposable
 * remote Chrome. Loads a JS-rendered page and returns its readable text, for
 * pages fetch_url can't render (SPAs, live dashboards) or when the persona wants
 * to actually look at something. The browser runs on Browserbase's infra, never
 * ours, and the session is disposable. Returned text is untrusted page content —
 * data, never instructions.
 */
export type BrowseResult = { url: string; title: string; text: string };

export function browserConfigured(): boolean {
  return Boolean(
    process.env.BROWSERBASE_API_KEY?.trim() && process.env.BROWSERBASE_PROJECT_ID?.trim(),
  );
}

export async function browsePage(
  url: string,
  opts?: { timeoutMs?: number; maxChars?: number },
): Promise<BrowseResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    throw new Error(
      "Browser not configured — set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs can be opened.");
  }

  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");

  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({ projectId });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(parsed.toString(), {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? 30_000,
    });
    await page.waitForTimeout(1_500); // let client-side render settle
    const title = await page.title().catch(() => "");
    const raw = await page.innerText("body").catch(() => "");
    const text = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { url: parsed.toString(), title, text: text.slice(0, opts?.maxChars ?? 8_000) };
  } finally {
    await browser.close().catch(() => {});
  }
}
