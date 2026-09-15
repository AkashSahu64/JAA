export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

type ScheduleName = 'ONCE' | 'HOURLY' | 'EVERY_3_HOURS' | 'DAILY' | 'WEEKLY' | 'CUSTOM';
const scheduleNames = new Set<ScheduleName>(['ONCE', 'HOURLY', 'EVERY_3_HOURS', 'DAILY', 'WEEKLY', 'CUSTOM']);

function values(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const [base, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new SchedulerError('Cron step is invalid');
    const range = base === '*' ? [min, max] : base.includes('-') ? base.split('-').map(Number) : [Number(base), Number(base)];
    if (range.length !== 2 || !range.every(value => Number.isInteger(value) && value >= min && value <= max) || range[0] > range[1]) {
      throw new SchedulerError('Cron range is invalid');
    }
    for (let value = range[0]; value <= range[1]; value += step) result.add(value);
  }
  return result;
}

function cronParts(expression: string): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new SchedulerError('Custom cron must contain five fields');
  return [values(parts[0], 0, 59), values(parts[1], 0, 23), values(parts[2], 1, 31), values(parts[3], 1, 12), values(parts[4], 0, 6)];
}

function localParts(date: Date, timeZone: string): [number, number, number, number, number] {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short' }).formatToParts(date);
    const part = (type: string) => formatted.find(item => item.type === type)?.value ?? '';
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return [Number(part('minute')), Number(part('hour')), Number(part('day')), Number(part('month')), weekdays.indexOf(part('weekday'))];
  } catch {
    throw new SchedulerError('Timezone is invalid');
  }
}

function validateTimeZone(timeZone: string): void {
  try {
    // Validate even schedules that do not currently calculate a next run. A
    // persisted profile must never carry an invalid timezone into a later
    // resume/update operation.
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new SchedulerError('Timezone is invalid');
  }
}

export function nextScheduledRun(schedule: ScheduleName, customCron: string | null | undefined, from: Date, timeZone = 'UTC'): Date | null {
  if (!scheduleNames.has(schedule)) throw new SchedulerError('Schedule name is invalid');
  if (!(from instanceof Date) || !Number.isFinite(from.getTime())) throw new SchedulerError('Schedule start time is invalid');
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new SchedulerError('Timezone is invalid');
  validateTimeZone(timeZone);
  if (schedule === 'ONCE') return null;
  const expression = schedule === 'HOURLY' ? '0 * * * *' : schedule === 'EVERY_3_HOURS' ? '0 */3 * * *'
    : schedule === 'DAILY' ? '0 0 * * *' : schedule === 'WEEKLY' ? '0 0 * * 0' : customCron;
  if (!expression) throw new SchedulerError('CUSTOM schedule requires a cron expression');
  const [minutes, hours, days, months, weekdays] = cronParts(expression);
  const candidate = new Date(from.getTime() - (from.getTime() % 60_000) + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const [minute, hour, day, month, weekday] = localParts(candidate, timeZone);
    if (minutes.has(minute) && hours.has(hour) && days.has(day) && months.has(month) && weekdays.has(weekday)) return candidate;
    candidate.setTime(candidate.getTime() + 60_000);
  }
  throw new SchedulerError('No scheduled run found within one year');
}
