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

/**
 * Post a reply to an X tweet as the persona, driving the logged-in session in a
 * real browser (X has no free write API). This is the follower-growth lever:
 * showing up with something useful under bigger accounts' posts. Fragile by
 * nature — it depends on X's DOM — and gated hard (x.com status URLs only,
 * daily reply cap upstream). `dryRun` reaches the composer without submitting,
 * so the selectors/auth can be verified without actually posting.
 */
export async function postReplyOnX(
  tweetUrl: string,
  text: string,
  opts?: { dryRun?: boolean; timeoutMs?: number },
): Promise<{ posted: boolean; composerFound: boolean }> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  const contextId = process.env.BROWSERBASE_X_CONTEXT_ID?.trim();
  if (!apiKey || !projectId) throw new Error("Browser not configured.");
  if (!contextId) throw new Error("X account not connected (no BROWSERBASE_X_CONTEXT_ID).");
  const body = text.trim();
  if (!body) throw new Error("Empty reply.");

  const u = new URL(tweetUrl);
  const host = u.hostname.toLowerCase().replace(/^\./, "");
  if (host !== "x.com" && host !== "www.x.com" && !host.endsWith(".x.com")) {
    throw new Error("Reply target must be an x.com status URL.");
  }
  if (!/\/status\/\d+/.test(u.pathname)) {
    throw new Error("Reply target must be a specific tweet (x.com/<user>/status/<id>).");
  }

  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");
  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({
    projectId,
    proxies: true,
    browserSettings: { context: { id: contextId, persist: false } },
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(u.toString(), {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? 40_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    // Focus the inline reply composer and type the reply.
    const composer = page.locator('[data-testid="tweetTextarea_0"]').first();
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    await composer.click();
    await page.keyboard.type(body, { delay: 15 });
    await page.waitForTimeout(500);

    if (opts?.dryRun) {
      return { posted: false, composerFound: true };
    }

    // Submit — inline reply button, with the standalone compose button as a fallback.
    const send = page
      .locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')
      .first();
    await send.waitFor({ state: "visible", timeout: 10_000 });
    await send.click();
    // Only claim success once the inline composer actually goes away — otherwise
    // the reply may not have posted (validation error, rate limit, DOM change).
    const posted = await page
      .locator('[data-testid="tweetButtonInline"]')
      .first()
      .waitFor({ state: "detached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(1_000);
    return { posted, composerFound: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

export type Screenshot = { bytes: Buffer; mimeType: "image/png" };

/**
 * Screenshot a real web page — the persona's way to attach REAL evidence to a
 * post (a benchmark chart, a tool's UI, a tweet, a GitHub diff) instead of an
 * AI-generated illustration. Returns PNG bytes for upload to the social API.
 */
export async function screenshotPage(
  url: string,
  opts?: { timeoutMs?: number; fullPage?: boolean; contextId?: string; proxies?: boolean },
): Promise<Screenshot> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    throw new Error("Browser not configured — set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.");
  }
  const parsed = await assertPublicUrl(url);

  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");

  const bb = new Browserbase({ apiKey });
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
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    const bytes = await page.screenshot({ type: "png", fullPage: opts?.fullPage ?? false });
    return { bytes, mimeType: "image/png" };
  } finally {
    await browser.close().catch(() => {});
  }
}
