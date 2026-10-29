export const TIME_ZONE = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short'
});

const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(date = new Date()) {
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayNumber[values.weekday]
  };
}

function offsetMilliseconds(date) {
  const p = nyParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMilliseconds(new Date(guess));
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function startOfNyDay(date = new Date()) {
  const p = nyParts(date);
  return zonedTimeToUtc(p.year, p.month, p.day);
}

export function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function nyDateKey(date = new Date()) {
  const p = nyParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function weekStartNy(date = new Date()) {
  const dayStart = startOfNyDay(date);
  const p = nyParts(dayStart);
  const sinceMonday = (p.weekday + 6) % 7;
  // Moving by whole UTC days preserves the NY midnight during ordinary weeks;
  // zoned conversion is re-applied below from the target NY calendar date.
  const rough = addUtcDays(dayStart, -sinceMonday);
  const rp = nyParts(rough);
  return zonedTimeToUtc(rp.year, rp.month, rp.day);
}

export function previousWeekRange(now = new Date()) {
  const currentStart = weekStartNy(now);
  const start = addUtcDays(currentStart, -7);
  const end = currentStart;
  return { start, end, key: nyDateKey(start) };
}

export function weekRangeFromKey(weekKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekKey || '');
  if (!match) return previousWeekRange(new Date());
  const start = zonedTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]));
  return { start, end: addUtcDays(start, 7), key: weekKey };
}

export function isWeeklyPublicationMoment(date = new Date()) {
  const p = nyParts(date);
  return p.weekday === 1 && p.hour === 7 && p.minute >= 13 && p.minute < 28;
}

export function formatNy(date, options = {}) {
  if (!date) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIME_ZONE,
    dateStyle: options.dateOnly ? 'medium' : undefined,
    timeStyle: options.dateOnly ? undefined : 'short',
    day: options.dateOnly ? undefined : '2-digit',
    month: options.dateOnly ? undefined : 'short',
    hour: options.dateOnly ? undefined : '2-digit',
    minute: options.dateOnly ? undefined : '2-digit'
  }).format(new Date(date));
}
