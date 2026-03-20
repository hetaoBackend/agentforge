function pad(value) {
  return String(value).padStart(2, "0");
}

function hasExplicitTimezone(value) {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function parseLocalDateTimeParts(value) {
  const match = String(value).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

export function parseTaskDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (hasExplicitTimezone(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parts = parseLocalDateTimeParts(raw);
  if (parts) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function formatTaskDateTime(value, options) {
  const date = parseTaskDateTime(value);
  return date ? date.toLocaleString(undefined, options) : "";
}

export function formatTaskTime(value, options) {
  const date = parseTaskDateTime(value);
  return date ? date.toLocaleTimeString(undefined, options) : "";
}

export function formatDateTimeLocalInput(value) {
  const date = parseTaskDateTime(value);
  if (!date) return "";
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

export function serializeDateTimeLocalInput(value) {
  const parts = parseLocalDateTimeParts(value);
  if (!parts) return null;
  return [
    parts.year,
    "-",
    pad(parts.month),
    "-",
    pad(parts.day),
    "T",
    pad(parts.hour),
    ":",
    pad(parts.minute),
    ":",
    pad(parts.second),
  ].join("");
}
