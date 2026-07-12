// Ported from tests/test_server_lifecycle.py for the Bun server shape.
//
// The Python QuietHTTPServer hook no longer exists; the stable lifecycle
// contract is that runServer owns a loopback Bun server, a TaskDB under HOME,
// default-disabled channels, and a clean stop path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { TaskDB } from "../src/db.ts";
import {
  killStaleProcessOnPort,
  runServer,
  type RunningServer,
} from "../src/server.ts";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to allocate a free port"));
      });
    });
  });
}

describe("server lifecycle", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedTelegramToken: string | undefined;
  let savedSlackBotToken: string | undefined;
  let savedSlackAppToken: string | undefined;
  let running: RunningServer | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-server-"));
    savedHome = process.env.HOME;
    savedTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    savedSlackBotToken = process.env.SLACK_BOT_TOKEN;
    savedSlackAppToken = process.env.SLACK_APP_TOKEN;
    process.env.HOME = tmpDir;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    running = null;
  });

  afterEach(async () => {
    if (running) {
      await running.stop();
      running = null;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedTelegramToken;
    if (savedSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
    if (savedSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = savedSlackAppToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("runServer serves health and leaves channels disabled by default", async () => {
    const port = await freePort();
    const dbPath = path.join(tmpDir, ".agentforge", "tasks.db");

    running = await runServer(port, dbPath);

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", tasks: 0 });
    expect(running.context.telegram_channel).toBeNull();
    expect(running.context.slack_channel).toBeNull();
    expect(running.context.weixin_channel).toBeNull();
    expect(running.context.feishu_channel).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, ".agentforge", "tasks.db"))).toBe(
      true,
    );
  });

  test("runServer creates a Feishu channel when settings enable it", async () => {
    const dbPath = path.join(tmpDir, ".agentforge", "tasks.db");
    const seed = new TaskDB(dbPath);
    seed.set_setting("feishu_enabled", "true");
    seed.close();
    const port = await freePort();

    running = await runServer(port, dbPath);

    expect(running.context.feishu_channel?.name).toBe("feishu");
    expect(running.context.feishu_channel?._running).toBe(false);
  });

  test("killStaleProcessOnPort handles closed ports and same-process listeners", async () => {
    await killStaleProcessOnPort(await freePort());

    const srv = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to listen"));
      });
    });

    try {
      await killStaleProcessOnPort(port);
      expect(srv.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
