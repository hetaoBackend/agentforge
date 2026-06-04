# Requirements Baseline

## Goal
Enhance the Weixin channel so messages in the same Weixin conversation continue the current AgentForge session by default, `/new` starts a new session, inbound Weixin images are attached to created/resumed tasks, and generated images can be sent back to Weixin.

## Non-goals
- Do not add new desktop UI settings.
- Do not change Feishu, Telegram, Slack, or frontend behavior.
- Do not implement Weixin group/thread UI beyond the available peer/context metadata.
- Do not support non-image media in this change.

## User-visible Behavior
- A normal Weixin message creates the first task for that peer.
- Later normal messages from the same Weixin peer resume the current task/session when possible.
- Sending `/new` or `/new <prompt>` starts a new current Weixin session for that peer.
- Weixin image messages create or resume tasks with image attachments.
- Task results that include generated local images send those images back to Weixin when the bridge can upload them.

## Acceptance Criteria
- Python tests cover default peer session continuation and `/new`.
- Python tests cover inbound image paths becoming task `image_paths` and `prompt_images`.
- Python tests cover outbound generated image paths becoming bridge image-send commands.
- Bridge syntax validates after image helper changes.
- Focused Weixin tests pass.

## Constraints
- Preserve existing dirty working tree changes.
- Keep the Weixin bridge as a standalone Node sidecar using stdio JSON.
- Use existing AgentForge `Task.image_paths` / `prompt_images` support.
- Avoid destructive git operations.

## Assumptions
- The current task for a Weixin peer can be tracked in process memory, matching existing `_task_origin` behavior.
- If a stored task has no `session_id`, the channel should create a new task instead of pretending to resume.
- Weixin image item protocol follows the existing `@tencent-weixin/openclaw-weixin` dist implementation found in the local backup package.
- Generated images are local files referenced by `generated_image` output events or markdown image references in the final result.

## Open Questions
None blocking.

## Source Request
“对于weixin channel，因为不天然支持thread，消息默认放到一个会话里去，可以通过类似 /new 的方式来新启动session，然后想办法支持微信中图片的上行和下行”

## Repo Context
- Existing Weixin MVP is text-only: `channels/weixin_channel.py` and `channels/weixin_bridge/index.mjs`.
- Existing task execution supports `image_paths` and `prompt_images`.
- Feishu channel already collects generated local images for outbound rich notifications.
