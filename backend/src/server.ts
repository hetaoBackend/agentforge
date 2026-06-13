import net from "node:net";

import { MessageBus, UIChannel } from "./bus.ts";
import { TaskDB } from "./db.ts";
import { logger } from "./log.ts";
import { TaskScheduler } from "./scheduler.ts";
import { handleApiRequest, type ApiContext } from "./api.ts";
import { FeishuChannel } from "./channels/feishu.ts";
import { SlackChannel } from "./channels/slack.ts";
import { create_telegram_channel } from "./channels/telegram.ts";
import { WeixinChannel } from "./channels/weixin.ts";

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killStaleProcessOnPort(port: number): Promise<void> {
  if (!(await portIsOpen(port))) return;
  try {
    const result = Bun.spawnSync({
      cmd: ["lsof", "-ti", `:${port}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    const pids = new TextDecoder()
      .decode(result.stdout)
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => /^\d+$/.test(p))
      .map((p) => Number.parseInt(p, 10))
      .filter((pid) => pid !== process.pid);

    for (const pid of pids) {
      logger.info(`Killing stale process ${pid} on port ${port}`);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have already exited.
      }
    }
    for (let i = 0; i < 10; i += 1) {
      await sleep(300);
      if (!pids.some(pidAlive)) return;
    }
    for (const pid of pids.filter(pidAlive)) {
      logger.warning(`Force-killing stale process ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may have already exited.
      }
    }
    await sleep(300);
  } catch (e) {
    logger.warning(`Could not clean up port ${port}: ${e}`);
  }
}

export interface RunningServer {
  server: Bun.Server<unknown>;
  context: ApiContext;
  stop(): Promise<void>;
}

export async function runServer(
  port = 9712,
  dbPath?: string,
): Promise<RunningServer> {
  await killStaleProcessOnPort(port);

  logger.info("Initializing database...");
  const db = new TaskDB(dbPath);

  logger.info("Initializing MessageBus...");
  const bus = new MessageBus();
  const uiChannel = new UIChannel(bus, db);
  uiChannel.start();

  logger.info("Initializing scheduler...");
  const scheduler = new TaskScheduler(db, () => undefined, bus);

  const context: ApiContext = {
    db,
    scheduler,
    bus,
    telegram_channel: null,
    slack_channel: null,
    weixin_channel: null,
    feishu_channel: null,
  };

  const tgEnabled =
    db.get_setting("telegram_enabled", "false") === "true" ||
    Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const tgToken =
    db.get_setting("telegram_bot_token", "") ||
    process.env.TELEGRAM_BOT_TOKEN ||
    "";
  const tgAllowed =
    db.get_setting("telegram_allowed_users", "") ||
    process.env.TELEGRAM_ALLOWED_USERS ||
    "";
  if (tgEnabled && tgToken) {
    logger.info("Starting Telegram channel...");
    context.telegram_channel = create_telegram_channel(
      db,
      scheduler,
      bus,
      tgToken,
      tgAllowed,
    );
    context.telegram_channel?.start();
  } else {
    logger.info("Telegram channel disabled");
  }

  const slEnabled =
    db.get_setting("slack_enabled", "false") === "true" ||
    Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
  const slBot =
    db.get_setting("slack_bot_token", "") || process.env.SLACK_BOT_TOKEN || "";
  const slApp =
    db.get_setting("slack_app_token", "") || process.env.SLACK_APP_TOKEN || "";
  if (slEnabled && slBot && slApp) {
    logger.info("Starting Slack channel...");
    context.slack_channel = new SlackChannel(bus, db, scheduler, slBot, slApp);
    void context.slack_channel.start();
  } else {
    logger.info("Slack channel disabled");
  }

  if (db.get_setting("weixin_enabled", "false") === "true") {
    logger.info("Starting Weixin channel...");
    context.weixin_channel = new WeixinChannel(bus, db, scheduler);
    context.weixin_channel.start();
  } else {
    logger.info("Weixin channel disabled");
  }

  if (db.get_setting("feishu_enabled", "false") === "true") {
    logger.info("Starting Feishu channel...");
    context.feishu_channel = new FeishuChannel(bus, db, scheduler);
    context.feishu_channel.start();
  } else {
    logger.info("Feishu channel disabled");
  }

  scheduler.start();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => handleApiRequest(context, req),
  });

  logger.info(`API server running on http://127.0.0.1:${port}`);
  logger.info(`Database at ${db.db_path}`);

  const stop = async (): Promise<void> => {
    logger.info("Shutting down...");
    context.telegram_channel?.stop();
    context.slack_channel?.stop();
    context.weixin_channel?.stop();
    context.feishu_channel?.stop();
    await scheduler.stop();
    db.conn.close();
    server.stop(true);
  };

  return { server, context, stop };
}
