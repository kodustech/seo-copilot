export const SCHEDULE_PRESET_VALUES = [
  "daily_9am",
  "weekly_monday",
  "weekly_friday",
  "biweekly",
  "monthly_first",
] as const;

export type SchedulePreset = (typeof SCHEDULE_PRESET_VALUES)[number];

export const DEFAULT_SCHEDULE_TIME = "09:00";

export const SCHEDULE_PRESETS: Record<SchedulePreset, { label: string }> = {
  daily_9am: { label: "Daily" },
  weekly_monday: { label: "Every Monday" },
  weekly_friday: { label: "Every Friday" },
  biweekly: { label: "Every two weeks" },
  monthly_first: { label: "Monthly" },
};

const SCHEDULE_ALIASES: Record<string, SchedulePreset> = {
  daily: "daily_9am",
  daily_9am: "daily_9am",
  weekly: "weekly_monday",
  weekly_monday: "weekly_monday",
  weekly_friday: "weekly_friday",
  biweekly: "biweekly",
  monthly: "monthly_first",
  monthly_first: "monthly_first",
};

function parseTime(time: string): { hour: number; minute: number } | null {
  const trimmed = time.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeSchedulePreset(value: string): SchedulePreset | null {
  return SCHEDULE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function normalizeScheduleTime(time: string): string | null {
  const parsed = parseTime(time);
  if (!parsed) return null;
  return formatTime(parsed.hour, parsed.minute);
}

export function buildCronExpressionForSchedule(
  schedule: SchedulePreset,
  time: string = DEFAULT_SCHEDULE_TIME,
): string | null {
  const parsed = parseTime(time);
  if (!parsed) return null;

  const { hour, minute } = parsed;

  if (schedule === "daily_9am") return `${minute} ${hour} * * *`;
  if (schedule === "weekly_monday") return `${minute} ${hour} * * 1`;
  if (schedule === "weekly_friday") return `${minute} ${hour} * * 5`;
  if (schedule === "biweekly") return `${minute} ${hour} 1,15 * *`;
  return `${minute} ${hour} 1 * *`;
}

export function describeCronExpression(cronExpression: string): string {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpression;

  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = parts;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return cronExpression;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return cronExpression;

  const time = formatTime(hour, minute);

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Daily at ${time}`;
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1") {
    return `Every Monday at ${time}`;
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "5") {
    return `Every Friday at ${time}`;
  }
  if (dayOfMonth === "1,15" && month === "*" && dayOfWeek === "*") {
    return `Every two weeks at ${time}`;
  }
  if (dayOfMonth === "1" && month === "*" && dayOfWeek === "*") {
    return `Monthly (day 1) at ${time}`;
  }

  return cronExpression;
}
