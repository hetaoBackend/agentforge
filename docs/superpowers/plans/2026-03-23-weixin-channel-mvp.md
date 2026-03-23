# Weixin Channel MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a text-only Weixin channel MVP backed by a Node sidecar bridge and a Python channel adapter.

**Architecture:** Python owns AgentForge integration and task/session bookkeeping. A small Node bridge owns Weixin transport concerns and communicates with Python using newline-delimited JSON over stdio.

**Tech Stack:** Python, pytest, Node.js, newline-delimited JSON, existing AgentForge channel abstractions

---

### Task 1: Add failing Python tests for Weixin channel behavior

**Files:**
- Create: `tests/test_weixin_channel.py`
- Modify: `channels/weixin_channel.py`

- [ ] Step 1: Write the failing tests for startup, inbound create/resume, and outbound send.
- [ ] Step 2: Run `pytest tests/test_weixin_channel.py -v` and confirm failure for missing implementation.
- [ ] Step 3: Add the minimal Python implementation to satisfy those tests.
- [ ] Step 4: Run `pytest tests/test_weixin_channel.py -v` and confirm pass.

### Task 2: Wire channel startup and settings

**Files:**
- Modify: `taskboard.py`
- Modify: `channels/README.md`

- [ ] Step 1: Add failing test coverage if practical for startup/config behavior.
- [ ] Step 2: Implement settings/startup wiring for Weixin channel.
- [ ] Step 3: Run focused tests for channel behavior.

### Task 3: Add Node bridge skeleton

**Files:**
- Create: `channels/weixin_bridge/package.json`
- Create: `channels/weixin_bridge/index.mjs`

- [ ] Step 1: Add the minimal bridge command protocol needed by Python tests.
- [ ] Step 2: Keep the transport stubbed if package wiring cannot be safely verified locally.
- [ ] Step 3: Document the expected runtime/config.
