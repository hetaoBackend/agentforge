import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";

import {
  ActionBtn,
  AgentBadge,
  Badge,
  HeaderButton,
  StatusPill,
  Tag,
  Tooltip,
  clamp,
  getStatusConfig,
} from "./common.tsx";
import { AGENTS } from "../constants.ts";
import type { TaskStatus } from "../types.ts";

afterEach(cleanup);

describe("clamp", () => {
  test("passes a value already inside the range through unchanged", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test("pins a value to whichever bound it crossed", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  test("an inverted range collapses to the minimum", () => {
    // Math.min runs after Math.max, so `min` wins when the bounds cross.
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe("Badge", () => {
  // Every status the backend can emit needs a label; the union comes from
  // backend/src/types.ts, so this list breaks if a status is added there.
  const statuses: TaskStatus[] = [
    "pending",
    "scheduled",
    "running",
    "completed",
    "failed",
    "cancelled",
    "blocked",
  ];

  test.each(statuses)("renders the configured label for %s", (status) => {
    render(<Badge status={status} />);

    expect(screen.getByText(getStatusConfig()[status].label)).toBeDefined();
  });

  test("falls back to the pending style for an unrecognised status", () => {
    render(<Badge status="not-a-real-status" />);

    expect(screen.getByText("Pending")).toBeDefined();
  });
});

describe("AgentBadge", () => {
  test("labels a known agent", () => {
    render(<AgentBadge agent="codex" />);

    expect(screen.getByText(AGENTS.codex.label)).toBeDefined();
  });

  test("falls back to Claude for an unknown agent", () => {
    render(<AgentBadge agent="some-future-agent" />);

    expect(screen.getByText(AGENTS.claude.label)).toBeDefined();
  });
});

describe("StatusPill", () => {
  test("shows the supplied label when connected", () => {
    render(<StatusPill connected label="telegram" />);

    expect(screen.getByText("telegram")).toBeDefined();
  });

  test("replaces the label with 'offline' when disconnected", () => {
    render(<StatusPill connected={false} label="telegram" />);

    expect(screen.getByText("offline")).toBeDefined();
    expect(screen.queryByText("telegram")).toBeNull();
  });
});

describe("Tag", () => {
  test("renders its children", () => {
    render(<Tag>nightly</Tag>);

    expect(screen.getByText("nightly")).toBeDefined();
  });
});

describe("ActionBtn", () => {
  test("exposes its title and fires onClick", () => {
    let clicks = 0;
    render(
      <ActionBtn
        icon={Bell}
        title="Notify"
        onClick={() => {
          clicks += 1;
        }}
        color="#fff"
      />,
    );

    fireEvent.click(screen.getByTitle("Notify"));

    expect(clicks).toBe(1);
  });
});

describe("HeaderButton", () => {
  test("labels the icon-only button for assistive tech and fires onClick", () => {
    let clicks = 0;
    render(
      <HeaderButton
        title="Refresh"
        onClick={() => {
          clicks += 1;
        }}
      >
        <Bell />
      </HeaderButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(clicks).toBe(1);
  });
});

describe("Tooltip", () => {
  test("reveals its text on hover and hides it again on leave", () => {
    render(
      <Tooltip text="explains the thing">
        <span>hover me</span>
      </Tooltip>,
    );
    const trigger = screen.getByText("hover me");

    expect(screen.queryByText("explains the thing")).toBeNull();

    act(() => {
      fireEvent.mouseEnter(trigger);
    });
    expect(screen.getByText("explains the thing")).toBeDefined();

    act(() => {
      fireEvent.mouseLeave(trigger);
    });
    expect(screen.queryByText("explains the thing")).toBeNull();
  });
});
