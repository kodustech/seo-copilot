/** A channel's posting cadence. Existing channels retain their daily cap. */
export type PostingFrequency = {
  period: "daily" | "weekly";
  posts: number;
  days: number[]; // UTC weekdays: Monday=1, Sunday=0.
};

export function postingFrequency(channel: { max_posts_per_day: number; channel_config: Record<string, unknown> }): PostingFrequency {
  const raw = channel.channel_config.posting_frequency as Partial<PostingFrequency> | undefined;
  if (!raw || raw.period !== "weekly" || !Number.isInteger(raw.posts) || Number(raw.posts) < 0) {
    return { period: "daily", posts: channel.max_posts_per_day, days: [] };
  }
  return {
    period: "weekly", posts: Number(raw.posts),
    days: Array.isArray(raw.days) ? [...new Set(raw.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : [],
  };
}

export function postingWeekStart(now: Date): string {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start.toISOString();
}

export function nextPostingDay(now: Date, days: number[], nextWeek = false): string {
  const next = nextWeek ? new Date(postingWeekStart(now)) : new Date(now);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + (nextWeek ? 7 : 1));
  for (let offset = 0; offset < 7; offset++) {
    if (!days.length || days.includes(next.getUTCDay())) return next.toISOString();
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}
