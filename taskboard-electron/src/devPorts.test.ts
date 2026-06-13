import { expect, test } from "bun:test";

import { lsofListeningPidsCommand } from "./devPorts.ts";

test("lsof command only selects processes listening on the backend port", () => {
  const command = lsofListeningPidsCommand(9712);

  expect(command).toContain("-tiTCP:9712");
  expect(command).toContain("-sTCP:LISTEN");
  expect(command).not.toContain(" :9712");
});
