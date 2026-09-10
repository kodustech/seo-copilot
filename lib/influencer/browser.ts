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

// ---------------------------------------------------------------------------
// Sessions that ACT, not only read
// ---------------------------------------------------------------------------

/** What every browser action needs before it can open a page. */
export function requireBrowserConfig(): { apiKey: string; projectId: string } {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    throw new Error(
      "Browser not configured — set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.",
    );
  }
  return { apiKey, projectId };
}

export type BrowserSessionOptions = {
  /** A persistent Browserbase context — a logged-in account. */
  contextId?: string;
  /** Write the context back when the session ends. Off by default: an action
   *  should not rewrite the persona's login state as a side effect. */
  persist?: boolean;
  /** Residential proxy, for platforms that block datacenter ranges. */
  proxies?: boolean;
  /** Seconds before Browserbase ends the session on its own. */
  timeoutSeconds?: number;
};

/**
 * One remote Chrome, one page, one callback, and the browser is closed
 * whatever the callback does. The read-only helpers above predate this and
 * still open their own sessions; anything that clicks or types goes through
 * here so the session lifecycle is written once.
 */
export async function withBrowserPage<T>(
  opts: BrowserSessionOptions,
  fn: (page: import("playwright-core").Page) => Promise<T>,
): Promise<T> {
  const { apiKey, projectId } = requireBrowserConfig();
  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");

  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({
    projectId,
    ...(opts.contextId
      ? { browserSettings: { context: { id: opts.contextId, persist: opts.persist ?? false } } }
      : {}),
    ...(opts.proxies ? { proxies: true } : {}),
    ...(opts.timeoutSeconds ? { api_timeout: opts.timeoutSeconds } : {}),
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

export type LoginSession = {
  /** The persistent context the login will be saved into. */
  context_id: string;
  session_id: string;
  /** Browserbase's live view: a person opens it, logs in, and closes the tab. */
  live_url: string;
  /** When Browserbase ends the session and saves the context. */
  expires_at: string;
};

/**
 * Start a session a PERSON drives: a fresh persistent context, a browser
 * pointed at the platform's sign-in page, and the live-view URL to hand over.
 * The context is written back when the session ends, so whatever login the
 * person completed inside it is what later `withBrowserPage` calls reuse.
 *
 * This is the whole "connect" for a platform with no API: the credential is a
 * cookie jar Browserbase holds, never a password we store.
 */
export async function startLoginSession(
  startUrl: string,
  opts?: { name?: string; proxies?: boolean; timeoutSeconds?: number },
): Promise<LoginSession> {
  const { apiKey, projectId } = requireBrowserConfig();
  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const { chromium } = await import("playwright-core");
  const bb = new Browserbase({ apiKey });

  const context = await bb.contexts.create({
    projectId,
    ...(opts?.name ? { name: opts.name } : {}),
  });
  const timeoutSeconds = opts?.timeoutSeconds ?? 15 * 60;
  const session = await bb.sessions.create({
    projectId,
    browserSettings: { context: { id: context.id, persist: true } },
    ...(opts?.proxies ? { proxies: true } : {}),
    // The person needs the tab to stay open while they type a password and
    // maybe clear a 2FA prompt; the default project timeout is built for
    // scripted runs, not for that.
    api_timeout: timeoutSeconds,
  });
  // Land the person on the sign-in page, then let go — the live view takes over.
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  } finally {
    // Disconnecting the CDP client must not end the session: the person is
    // about to use it. Browserbase keeps it alive until api_timeout.
    await browser.close().catch(() => {});
  }
  const live = await bb.sessions.debug(session.id);
  return {
    context_id: context.id,
    session_id: session.id,
    live_url: live.debuggerFullscreenUrl,
    expires_at: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
  };
}

/**
 * End a session now. A persistent context is written back when its session
 * ends, so the connect step releases the login session before it checks the
 * context — otherwise the check runs against a jar that isn't saved yet.
 */
export async function releaseSession(sessionId: string): Promise<void> {
  const { apiKey, projectId } = requireBrowserConfig();
  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const bb = new Browserbase({ apiKey });
  await bb.sessions.update(sessionId, { projectId, status: "REQUEST_RELEASE" }).catch(() => {});
}

/** Forget a persistent context — the login it holds with it. */
export async function deleteContext(contextId: string): Promise<void> {
  const { apiKey } = requireBrowserConfig();
  const { default: Browserbase } = await import("@browserbasehq/sdk");
  const bb = new Browserbase({ apiKey });
  await bb.contexts.delete(contextId).catch(() => {});
}
