// Minimal logger matching the Python logging setup in taskboard.py:
// level from AGENTFORGE_LOG_LEVEL, "%Y-%m-%d %H:%M:%S LEVEL name: message".

const LEVELS: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

const envLevel = (process.env.AGENTFORGE_LOG_LEVEL ?? "INFO").toUpperCase();
const ROOT_LEVEL = LEVELS[envLevel] ?? LEVELS.INFO!;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export class Logger {
  constructor(readonly name: string) {}

  private emit(levelName: string, level: number, args: unknown[]): void {
    if (level < ROOT_LEVEL) return;
    const line = `${timestamp()} ${levelName} ${this.name}:`;
    if (level >= LEVELS.ERROR!) console.error(line, ...args);
    else if (level >= LEVELS.WARNING!) console.warn(line, ...args);
    else console.log(line, ...args);
  }

  debug(...args: unknown[]): void {
    this.emit("DEBUG", LEVELS.DEBUG!, args);
  }

  info(...args: unknown[]): void {
    this.emit("INFO", LEVELS.INFO!, args);
  }

  warning(...args: unknown[]): void {
    this.emit("WARNING", LEVELS.WARNING!, args);
  }

  error(...args: unknown[]): void {
    this.emit("ERROR", LEVELS.ERROR!, args);
  }

  exception(...args: unknown[]): void {
    this.emit("ERROR", LEVELS.ERROR!, args);
  }
}

export function getLogger(name: string): Logger {
  return new Logger(name);
}

export const logger = getLogger("agentforge");
