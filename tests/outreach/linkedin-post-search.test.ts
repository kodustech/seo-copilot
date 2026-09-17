/**
 * The post search hits a different Unipile endpoint from the rest of the
 * harvest path, with the filters in a POST body and a result shape that is
 * not the one `/posts/{id}` returns. These tests pin the request we send and
 * the mapping we do, because both are invisible until a queue comes back with
 * null authors or LinkedIn refuses a limit it never accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyPostVoice, isSelfAuthored } from "../../lib/linkedin-harvest";
import {
  linkedInAccountIdentity,
  resetUnipileAccountsCache,
  searchUnipilePosts,
} from "../../lib/unipile";

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const postItem = {
  id: "post-1",
  social_id: "urn:li:activity:7500157386603720705",
  share_url:
    "https://www.linkedin.com/posts/pustelto_code-review-activity-7500157386603720705-SfkU",
  date: "2w",
  parsed_datetime: "2026-08-31T09:12:00.000Z",
  text: "Our team's review queue doubled after we shipped agents.",
  reaction_counter: 30,
  comment_counter: 6,
  author: {
    name: "Test Author",
    headline: "Staff Engineer",
    public_identifier: "testauthor",
    is_company: false,
  },
};

describe("searchUnipilePosts", () => {
  const calls: Call[] = [];

  beforeEach(() => {
    calls.length = 0;
    process.env.UNIPILE_API_KEY = "vitest-key";
    process.env.UNIPILE_DSN = "api-test.unipile.com:443";
    // No pacing in tests: the interval exists to protect the real account,
    // and waiting for it here would only make the suite slow.
    process.env.UNIPILE_HARVEST_MIN_INTERVAL_MS = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(pages: unknown[]): void {
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        const body = pages[Math.min(i, pages.length - 1)];
        i += 1;
        return jsonResponse(body);
      }),
    );
  }

  it("posts the classic posts category and maps a result", async () => {
    stubFetch([{ items: [postItem], cursor: null }]);

    const { posts } = await searchUnipilePosts({
      keywords: "code review bottleneck",
      accountId: "acc-1",
      datePosted: "past_month",
      sortBy: "date",
      authorKeywords: "engineering manager",
      maxResults: 5,
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain("/api/v1/linkedin/search");
    expect(url).toContain("account_id=acc-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      api: "classic",
      category: "posts",
      keywords: "code review bottleneck",
      date_posted: "past_month",
      sort_by: "date",
      author: { keywords: "engineering manager" },
    });

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post.activityId).toBe("7500157386603720705");
    expect(post.authorName).toBe("Test Author");
    expect(post.authorHeadline).toBe("Staff Engineer");
    expect(post.authorProfileUrl).toBe(
      "https://www.linkedin.com/in/testauthor",
    );
    expect(post.authorIsCompany).toBe(false);
    // The ISO timestamp is the storable one; LinkedIn's "2w" is kept beside
    // it rather than parsed into a date nobody can trust.
    expect(post.postedAt).toBe("2026-08-31T09:12:00.000Z");
    expect(post.postedAtRelative).toBe("2w");
    expect(post.reactionCount).toBe(30);
  });

  it("asks LinkedIn for a limit it accepts", async () => {
    stubFetch([{ items: [postItem], cursor: null }]);

    await searchUnipilePosts({
      keywords: "pr review queue",
      accountId: "acc-1",
      maxResults: 1,
    });

    // LinkedIn rejects a post search asking for fewer than 3, so a caller
    // wanting one post still has to request three and slice.
    expect(calls[0].url).toContain("limit=3");
  });

  it("stops when a page brings nothing new instead of paying for more", async () => {
    stubFetch([
      { items: [postItem], cursor: "next-1" },
      { items: [postItem], cursor: "next-2" },
    ]);

    const { posts } = await searchUnipilePosts({
      keywords: "code review",
      accountId: "acc-1",
      maxResults: 50,
    });

    expect(posts).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("cursor=next-1");
  });

  it("falls through to the share URL when social_id carries no activity id", async () => {
    stubFetch([
      {
        items: [
          {
            ...postItem,
            // A real id, just not an activity one. Coalescing on null alone
            // would stop here and leave the post unharvestable.
            social_id: "urn:li:fsd_update:12345",
          },
        ],
        cursor: null,
      },
    ]);

    const { posts } = await searchUnipilePosts({
      keywords: "code review",
      accountId: "acc-1",
    });

    expect(posts[0].activityId).toBe("7500157386603720705");
  });

  it("reads the author member id from a urn when there is no id field", async () => {
    stubFetch([
      {
        items: [
          {
            ...postItem,
            author: { name: "Urn Only", urn: "urn:li:fsd_profile:ACoAAAwjjB0B" },
          },
        ],
        cursor: null,
      },
    ]);

    const { posts } = await searchUnipilePosts({
      keywords: "code review",
      accountId: "acc-1",
    });

    expect(posts[0].authorProviderId).toBe("ACoAAAwjjB0B");
  });

  it("keeps paging when an excluded post would otherwise eat the result", async () => {
    const ours = {
      ...postItem,
      id: "post-ours",
      social_id: "urn:li:activity:7000000000000000001",
      author: { name: "Us", public_identifier: "kodus-founder" },
      text: "we shipped a thing",
    };
    stubFetch([
      { items: [ours], cursor: "next-1" },
      { items: [postItem], cursor: null },
    ]);

    const { posts, excluded } = await searchUnipilePosts({
      keywords: "code review",
      accountId: "acc-1",
      maxResults: 1,
      exclude: (p) => p.authorPublicIdentifier === "kodus-founder",
    });

    expect(excluded).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].authorName).toBe("Test Author");
    expect(calls).toHaveLength(2);
  });

  it("keeps a result that has text but no author object", async () => {
    stubFetch([
      {
        items: [
          {
            id: "post-2",
            author: "Plain Name String",
            text: "nosso time parou de conseguir revisar tudo",
          },
        ],
        cursor: null,
      },
    ]);

    const { posts } = await searchUnipilePosts({
      keywords: "revisão de código",
      accountId: "acc-1",
    });

    expect(posts[0].authorName).toBe("Plain Name String");
    expect(posts[0].activityId).toBeNull();
  });
});

describe("classifyPostVoice", () => {
  it("flags a first-person team problem in English and Portuguese", () => {
    expect(
      classifyPostVoice("Our review queue grew 3x after we shipped agents")
        .ownTeam,
    ).toBe(true);
    expect(
      classifyPostVoice("nosso time não dá conta de revisar os PRs").ownTeam,
    ).toBe(true);
  });

  it("does not flag commentary about the industry", () => {
    const voice = classifyPostVoice(
      "AI is generating code faster than teams can review it. Interesting read.",
    );
    expect(voice.ownTeam).toBe(false);
    expect(voice.vendorish).toBe(false);
  });

  it("flags selling", () => {
    expect(
      classifyPostVoice("We help teams ship faster. Book a demo today!")
        .vendorish,
    ).toBe(true);
  });

  it("treats empty text as unknown rather than guessing", () => {
    expect(classifyPostVoice(null)).toEqual({
      ownTeam: false,
      vendorish: false,
    });
  });
});

/**
 * `isSelfAuthored` tested alone proves the comparison, not the wiring. These
 * drive the resolver against an accounts payload, because self-exclusion fails
 * silently: the slug arrives null, nothing matches, and our own posts come
 * back in the queue looking like prospects.
 */
describe("linkedInAccountIdentity", () => {
  beforeEach(() => {
    process.env.UNIPILE_API_KEY = "vitest-key";
    process.env.UNIPILE_DSN = "api-test.unipile.com:443";
    delete process.env.UNIPILE_LINKEDIN_ACCOUNT_ID;
    resetUnipileAccountsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetUnipileAccountsCache();
  });

  function stubAccounts(im: Record<string, unknown>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: "acc-li",
              type: "LINKEDIN",
              name: "Gabriel",
              connection_params: { im },
            },
          ],
        }),
      ),
    );
  }

  it("reads the slug and the member id off the LinkedIn account", async () => {
    stubAccounts({
      id: "ACoAAself",
      username: "gabrielmalinosqui",
      publicIdentifier: "gabrielmalinosqui",
    });

    const identity = await linkedInAccountIdentity();

    expect(identity.accountId).toBe("acc-li");
    expect(identity.providerUserId).toBe("ACoAAself");
    expect(identity.publicIdentifier).toBe("gabrielmalinosqui");
  });

  it("falls back to the username when the account carries no publicIdentifier", async () => {
    stubAccounts({ id: "ACoAAself", username: "gabrielmalinosqui" });

    const identity = await linkedInAccountIdentity();

    expect(identity.publicIdentifier).toBe("gabrielmalinosqui");
  });

  it("ignores a username that is an email rather than a slug", async () => {
    stubAccounts({ id: "ACoAAself", username: "gabriel@kodus.io" });

    const identity = await linkedInAccountIdentity();

    expect(identity.publicIdentifier).toBeNull();
  });
});

describe("isSelfAuthored", () => {
  it("matches on the member id", () => {
    expect(
      isSelfAuthored(
        { authorProviderId: "ACoAAself", authorPublicIdentifier: "someone" },
        { providerUserId: "acoaaself" },
      ),
    ).toBe(true);
  });

  it("matches on the profile slug when the response has no member id", () => {
    expect(
      isSelfAuthored(
        { authorProviderId: null, authorPublicIdentifier: "GabrielMalinosqui" },
        { publicIdentifier: "gabrielmalinosqui" },
      ),
    ).toBe(true);
  });

  it("keeps other people, and does not treat two unknowns as a match", () => {
    expect(
      isSelfAuthored(
        { authorProviderId: "ACoAAother", authorPublicIdentifier: "other" },
        { providerUserId: "ACoAAself", publicIdentifier: "self" },
      ),
    ).toBe(false);
    // Self-exclusion off (no identity resolved) must not drop every post.
    expect(
      isSelfAuthored(
        { authorProviderId: null, authorPublicIdentifier: null },
        { providerUserId: null, publicIdentifier: null },
      ),
    ).toBe(false);
  });
});
