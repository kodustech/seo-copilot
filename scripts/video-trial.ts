// Prompt-only against templates: can a persona write a POC-quality video by
// itself? Turns one post into a video twice, once per slide mode, with the
// brief and validators the persona's queue_draft uses, retrying on the same
// errors the tool would return. Then renders the slides. No HeyGen and no
// database: the only spend is the model call.
//
// Usage:
//   npx tsx scripts/video-trial.ts <post.md> <out_dir> [--mode layouts|html|both] [--provider app|claude-cli] [--model name]
//   --provider app (default): the app's own model (AI_PROVIDER, as the fleet uses).
//   --provider claude-cli: the local `claude` CLI with a bare context, for when
//     no model key works locally. It measures the brief, not the fleet's model.
//   VIDEO_TRIAL_PYTHON=<python with playwright> (default python3)
//   VIDEO_TRIAL_PERSONA="Theo (@theo), who writes agentwrotethis.dev about engineering with coding agents"

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateObject } from "ai";
import { z } from "zod";

import { getModel } from "../lib/ai/provider";
import {
  buildYoutubeBrief,
  countSpokenWords,
  estimateSpeechSeconds,
  estimateVideoCost,
  parseVideoBlocks,
  parseVideoVisuals,
  validateVideoLength,
  validateVideoScript,
  VIDEO_SLIDE_INPUT_SCHEMA,
  youtubeChannelConfig,
  type YoutubeSlideMode,
} from "../lib/influencer/youtube";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, key, value] = m;
      if (process.env[key] === undefined) process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    // env may be injected directly
  }
}

const VideoDraft = z.object({
  title: z.string().describe("YouTube title, under 100 chars"),
  blocks: z.array(z.string()),
  slides: z.array(VIDEO_SLIDE_INPUT_SCHEMA),
});

type Draft = z.infer<typeof VideoDraft>;
type Writer = (system: string, prompt: string) => Promise<Draft>;

function appWriter(): Writer {
  const model = getModel();
  return async (system, prompt) => (await generateObject({ model, schema: VideoDraft, system, prompt })).object;
}

function claudeCliWriter(model: string): Writer {
  // The CLI's validator does not resolve the draft-2020 meta-schema zod names.
  const { $schema: _meta, ...jsonSchema } = z.toJSONSchema(VideoDraft) as Record<string, unknown>;
  void _meta;
  const schema = JSON.stringify(jsonSchema);
  return async (system, prompt) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // a stale key would shadow the CLI's own login
    const out = execFileSync(
      "claude",
      [
        "-p", prompt,
        "--system-prompt", system,
        "--output-format", "json",
        "--json-schema", schema,
        "--tools", "",
        "--model", model,
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources", "",
      ],
      { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out) as { structured_output?: unknown; result?: string };
    return VideoDraft.parse(parsed.structured_output);
  };
}

async function trial(post: string, mode: YoutubeSlideMode, outDir: string, write: Writer, modelName: string) {
  const cfg = youtubeChannelConfig({
    channel_config: { youtube_slide_mode: mode, youtube_site_url: "agentwrotethis.dev" },
  });
  const persona =
    process.env.VIDEO_TRIAL_PERSONA ??
    "Theo (@theo), who writes agentwrotethis.dev about engineering with coding agents";
  const system = [
    `You are ${persona}. You are making a video for your YouTube channel, in your own voice.`,
    buildYoutubeBrief(cfg, null),
  ].join("\n\n");
  let prompt = `Turn this post of yours into a video. Return the title, the blocks and the slides exactly as queue_draft takes them.\n\n<post>\n${post}\n</post>`;
  const attempts: { issues: string[] }[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const object = await write(system, prompt);
    const issues = [...validateVideoScript(object.blocks)];
    const blocks = parseVideoBlocks(object.blocks) ?? [];
    if (!issues.length) issues.push(...validateVideoLength(blocks, cfg.targetMinutes));
    const { visuals, issues: visualIssues } = parseVideoVisuals(object.slides, blocks.length, mode);
    issues.push(...visualIssues);
    attempts.push({ issues });
    if (!issues.length) {
      const dir = resolve(outDir, mode);
      mkdirSync(dir, { recursive: true });
      const seconds = estimateSpeechSeconds(blocks);
      const result = {
        mode,
        model: modelName,
        attempts,
        title: object.title,
        words: countSpokenWords(blocks),
        estimated_seconds: seconds,
        estimated_credits: estimateVideoCost(seconds),
        on_camera_blocks: visuals.filter((v) => v === null).length,
        blocks,
        visuals,
      };
      writeFileSync(resolve(dir, "video.json"), JSON.stringify(result, null, 2));
      writeFileSync(resolve(dir, "visuals.json"), JSON.stringify(visuals));
      writeFileSync(
        resolve(dir, "script.md"),
        [`# ${object.title}`, "", ...blocks.map((b, i) => `**${i + 1}** ${visuals[i] ? "(slide)" : "(on camera)"} ${b}\n`)].join("\n"),
      );
      execFileSync(
        process.env.VIDEO_TRIAL_PYTHON ?? "python3",
        [resolve("worker/slides.py"), resolve(dir, "visuals.json"), dir, "--site", "agentwrotethis.dev"],
        { stdio: "inherit" },
      );
      console.log(`${mode}: ok after ${attempt} attempt(s), ${result.words} words, ~${seconds}s, ~${result.estimated_credits} credits`);
      return;
    }
    console.log(`${mode}: attempt ${attempt} refused:\n  ${issues.join("\n  ")}`);
    // What the tool would have said back to the persona.
    prompt += `\n\nqueue_draft refused your last draft:\n${issues.join("\n")}\nFix it and return the whole draft again.`;
  }
  throw new Error(`${mode}: no valid draft after 3 attempts`);
}

async function main() {
  loadEnv();
  const [postPath, outDir] = process.argv.slice(2);
  if (!postPath || !outDir) throw new Error("usage: video-trial.ts <post.md> <out_dir> [--mode layouts|html|both] [--model name]");
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const mode = flag("mode") ?? "both";
  const provider = flag("provider") ?? "app";
  const modelName = provider === "claude-cli" ? (flag("model") ?? "sonnet") : `app:${process.env.AI_PROVIDER ?? "kimi"}`;
  const write = provider === "claude-cli" ? claudeCliWriter(modelName) : appWriter();
  const post = readFileSync(postPath, "utf8");
  const modes: YoutubeSlideMode[] = mode === "both" ? ["layouts", "html"] : [mode as YoutubeSlideMode];
  for (const m of modes) await trial(post, m, outDir, write, modelName);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
