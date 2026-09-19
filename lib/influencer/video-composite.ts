/**
 * Video composite plan: the deterministic recipe that turns rendered avatar
 * clips + slide images + narration audio into the finished mp4.
 *
 * The plan is pure data (built here, tested here). The actual ffmpeg work
 * runs OUTSIDE the web server — `scripts/render-video-from-plan.py` — because
 * it needs ffmpeg, fonts, and minutes of CPU that serverless will not give.
 * The publisher never renders; it only advances an activity to "ready" once
 * the finished file (plus its SRT) is attached.
 */

export type CompositeSegment =
  | {
      kind: "intro";
      /** Full-frame avatar clip with its setting (no slides here). */
      avatarMp4: string;
      durationSeconds: number;
    }
  | {
      kind: "slide";
      slidePng: string;
      /** Circular bubble; white matte, keyed out at render. */
      avatarMp4: string;
      durationSeconds: number;
    };

export type CompositePlan = {
  version: 1;
  segments: CompositeSegment[];
  musicMp3: string | null;
  /** 0.0-1.0 bed level under the voice. */
  musicLevel: number;
  captionsSrt: string | null;
  /** Karaoke word timings; when present the renderer highlights each word. */
  wordsJson: string | null;
  outputMp4: string;
};

export function buildCompositePlan(input: {
  introAvatarMp4: string;
  introSeconds: number;
  slides: { png: string; avatarMp4: string; seconds: number }[];
  musicMp3?: string | null;
  musicLevel?: number;
  captionsSrt?: string | null;
  wordsJson?: string | null;
  outputMp4: string;
}): CompositePlan {
  if (!input.introAvatarMp4) throw new Error("intro avatar clip is required.");
  if (!input.slides.length) throw new Error("at least one slide segment is required.");
  for (const [i, s] of input.slides.entries()) {
    if (!s.png || !s.avatarMp4) throw new Error(`slide segment ${i + 1} needs a png and an avatar clip.`);
    if (!(s.seconds > 0)) throw new Error(`slide segment ${i + 1} needs a positive duration.`);
  }
  const level = input.musicLevel ?? 0.08;
  if (!(level >= 0 && level <= 0.3)) throw new Error("musicLevel must sit between 0 and 0.3 — the bed never fights the voice.");
  return {
    version: 1,
    segments: [
      { kind: "intro", avatarMp4: input.introAvatarMp4, durationSeconds: input.introSeconds },
      ...input.slides.map((s) => ({
        kind: "slide" as const,
        slidePng: s.png,
        avatarMp4: s.avatarMp4,
        durationSeconds: s.seconds,
      })),
    ],
    musicMp3: input.musicMp3 ?? null,
    musicLevel: level,
    captionsSrt: input.captionsSrt ?? null,
    wordsJson: input.wordsJson ?? null,
    outputMp4: input.outputMp4,
  };
}

/** Total runtime the plan will produce, for cost + schedule sanity checks. */
export function compositePlanSeconds(plan: CompositePlan): number {
  return plan.segments.reduce((sum, s) => sum + s.durationSeconds, 0);
}
