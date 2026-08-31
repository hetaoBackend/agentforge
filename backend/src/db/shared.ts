// Types shared by the TaskDB repository modules.

/** A row as bun:sqlite hands it back (≙ sqlite3.Row in the Python port). */
export type Row = Record<string, any>;

/** Constructor shape a repository mixin can extend. */
export type DbCtor<T> = new (...args: any[]) => T;
