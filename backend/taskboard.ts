import { logger } from "./src/log.ts";
import { runServer } from "./src/server.ts";

const rawPort = process.argv[2];
const port = rawPort ? Number.parseInt(rawPort, 10) : 9712;
const dbPath = process.argv[3];

logger.info(
  `=== Bun backend starting at ${new Date().toISOString()} on port ${port} ===`,
);

const running = await runServer(port, dbPath);
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await running.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
