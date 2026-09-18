export type ContentQualityIssue = {
  code: string;
  message: string;
};

const LONG_FORM_PLATFORMS = new Set(["blog", "devto", "hackernoon"]);
const MARKDOWN_LINK = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const MARKDOWN_IMAGE =
  /!\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*?)\]\([ \t]*(<[^\n<>]*>|[^\s)]*)(?:(?:[ \t]+|[ \t]*(?:\r\n|\r|\n)[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/g;
const RAW_URL = /https?:\/\/[^\s)]+/gi;
const WEAK_ANCHORS = new Set(["here", "source", "link", "click here"]);

function wordCount(text: string): number {
  return text
    .replace(/[`*_>#\[\]()]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function externalLinks(content: string): Array<{ anchor: string; url: string }> {
  return Array.from(content.matchAll(MARKDOWN_LINK), (match) => ({
    anchor: match[1].trim(),
    url: match[2].trim(),
  }));
}

/**
 * Long-form content has a different contract from social content. This is a
 * deliberately small, deterministic gate: it catches objective failures
 * before a draft reaches review, while leaving editorial judgment (topic,
 * angle, whether Kodus belongs) to the persona and the human reviewer.
 */
export function validateLongFormContent(input: {
  platform: string;
  title?: string | null;
  description?: string | null;
  content: string;
}): ContentQualityIssue[] {
  if (!LONG_FORM_PLATFORMS.has(input.platform)) return [];

  const issues: ContentQualityIssue[] = [];
  const content = input.content.trim();
  const headings = Array.from(content.matchAll(/^##\s+(.+)$/gm));
  const subheadings = Array.from(content.matchAll(/^###\s+(.+)$/gm));
  const links = externalLinks(content);

  if (wordCount(content) < 1000) {
    issues.push({
      code: "long_form_too_short",
      message: "Long-form articles must contain at least 1,000 words of useful content.",
    });
  }
  if (headings.length < 3) {
    issues.push({
      code: "long_form_headings_missing",
      message: "Long-form articles need at least 3 H2 sections (the title is the page H1).",
    });
  }
  const firstH2Index = headings[0]?.index ?? Infinity;
  if (subheadings.some((match) => firstH2Index > match.index!)) {
    issues.push({
      code: "long_form_heading_order",
      message: "H3 sections must follow an H2 section; do not start with H3 headings.",
    });
  }
  if (links.length < 3) {
    issues.push({
      code: "long_form_sources_missing",
      message: "Add at least 3 research links as natural markdown anchors in the article.",
    });
  }
  if (links.some(({ anchor }) => !anchor || WEAK_ANCHORS.has(anchor.toLowerCase()))) {
    issues.push({
      code: "long_form_weak_anchor",
      message: "Research links need descriptive, contextual anchor text—not 'source', 'here', or 'click here'.",
    });
  }

  const linkedUrls = new Set(links.map(({ url }) => url));
  const scannableContent = content.replace(MARKDOWN_IMAGE, "$1");
  const unlinkedUrls = (scannableContent.match(RAW_URL) ?? []).filter((url) => !linkedUrls.has(url));
  if (unlinkedUrls.length) {
    issues.push({
      code: "long_form_raw_url",
      message: "Replace raw URLs with natural markdown links such as [official documentation](URL).",
    });
  }

  return issues;
}

export function formatContentQualityIssues(issues: ContentQualityIssue[]): string {
  return issues.map((issue) => `- ${issue.message}`).join("\n");
}
