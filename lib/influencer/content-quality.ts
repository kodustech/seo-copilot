import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type ContentQualityIssue = {
  code: string;
  message: string;
};

const LONG_FORM_PLATFORMS = new Set(["blog", "devto", "hackernoon"]);
const MARKDOWN_LINK = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const RAW_URL = /https?:\/\/[^\s)]+/gi;
const WEAK_ANCHORS = new Set(["here", "source", "link", "click here"]);
const RESEARCH_PROCESS_NOTE =
  /\b(?:checked|accessed|retrieved|reviewed|read|consulted|looked at)\s+(?:from\s+|in\s+)?(?:the\s+)?(?:vendor|project|official|product)?\s*(?:page|documentation|docs?|source|site|repository|repo|material(?:s)?)\b[^\n.]{0,40}\b(?:on|as of)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|\b(?:verificad[oa]|consultad[oa]|acessad[oa]|lida|le[iu]da|revisad[oa])\s+(?:n[oa]\s+)?(?:documentação|página|fonte|site|repositório|material)\b[^\n.]{0,40}\b(?:em|no dia)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i;
// Access stamps can be formatted as lists, quotes, emphasis or source notes.
// Keep this anchored so ordinary event dates inside prose remain valid.
const STAMP_START = String.raw`(?:^|\()[ \t]*(?:#{1,6}[ \t]*)?(?:(?:[-*+>]|\d+[.)])[ \t]+)*[*_]*[ \t]*(?:(?:sources?|fontes?|references?|notes?|notas?)[ \t]*:?[ \t]*[*_]*[ \t]*)?`;
const STAMP_DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})`;
const RESEARCH_ACCESS_STAMP = new RegExp(
  String.raw`${STAMP_START}(?:(?:accessed|retrieved|consulted)\s+(?:on|as of)|(?:consultad[oa]|acessad[oa])\s+(?:(?:em|no dia)|n[oa]\s+(?:site|documentação|página|fonte|repositório|material)\b[^\n.]{0,40}?\s+(?:em|no dia)))\s+${STAMP_DATE}`,
  "im",
);
const RESEARCH_DATE_PROVENANCE =
  /\b(?:everything here|this article|these findings|o artigo|este texto)\b[^\n.]{0,160}\b(?:read|based|lido|baseado)\b[^\n.]{0,100}\b(?:on|from|em|de)\b[^\n.]{0,100}\b(?:vendor|project|documentation|documentação|fornecedor|projeto)\b[^\n.]{0,100}\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i;

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

/** Remove only images recognized by the CommonMark parser used by remark.
 * Keep their alt text so a visible bare URL there is still checked.
 * Invalid constructs remain untouched, including interrupted image titles.
 */
function withoutImageDestinations(content: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const pending: Array<typeof tree | (typeof tree.children)[number]> = [tree];
  const images: Array<{ start: number; end: number; alt: string }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "image") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        images.push({ start, end, alt: node.alt ?? "" });
      }
    } else if ("children" in node) {
      pending.push(...node.children);
    }
  }
  images.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const image of images) {
    parts.push(content.slice(cursor, image.start), image.alt);
    cursor = image.end;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
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
  const content = input.content.replace(/\r\n?/g, "\n").trim();
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
  if (RESEARCH_PROCESS_NOTE.test(content) || RESEARCH_ACCESS_STAMP.test(content) || RESEARCH_DATE_PROVENANCE.test(content)) {
    issues.push({
      code: "long_form_research_process_note",
      message: "Remove research-process notes and access dates from the article; cite the source naturally instead.",
    });
  }

  const linkedUrls = new Set(links.map(({ url }) => url));
  const scannableContent = withoutImageDestinations(content);
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
