# Implementation Plan

## Goal And Architecture
Add Weixin peer-level session continuity in Python, plus image metadata flow between the Node bridge and AgentForge tasks. Python remains the AgentForge adapter; Node remains the Weixin transport adapter.

## Files Expected To Change
- `tests/test_weixin_channel.py`
- `channels/weixin_channel.py`
- `channels/weixin_bridge/index.mjs`
- `docs/todo.md`
- `docs/dev-loop-runs/2026-06-03-weixin-session-images/*`

## Task Order
1. Add failing Python tests for peer default resume, `/new`, inbound images, and outbound generated images.
2. Implement Python helpers:
   - peer current-task map
   - `/new` parsing
   - image prompt construction
   - generated image collection and outbound image command fields
3. Implement bridge helpers:
   - detect image items in inbound updates
   - download/decrypt inbound images into `DATA_DIR/media/inbound`
   - upload outbound local images to CDN and send image items
4. Run focused tests and syntax checks.
5. Record implementation and acceptance evidence.

## Test Strategy
- `uv run pytest -q tests/test_weixin_channel.py`
- `node --check channels/weixin_bridge/index.mjs`
- If practical, `make check` for repo-wide verification.

## Risks
- Weixin CDN behavior cannot be integration-tested without a live account.
- The local package dist is the best available protocol reference; keep helpers small and defensive.
- Existing dirty files are unrelated and must remain untouched.

## Acceptance Mapping
- `/new` and default continuation: covered by Weixin channel unit tests.
- Inbound images: covered by task object assertions.
- Outbound images: covered by bridge command assertions plus bridge syntax check.
