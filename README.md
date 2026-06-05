# changelog-notify

One action that posts release/deploy notifications to **Slack and/or Discord**,
then **edits the same message** as a deploy progresses
(`deploying` → `released` / `failed`). Providers are auto-detected from the
configuration you pass — set Slack, Discord, or both.

Part of the changelog actions suite:
`changelog-generate` → `changelog-merge` → `changelog-release` → **`changelog-notify`**.

## How it works

- **Slack** uses the Web API (`chat.postMessage` / `chat.update`) with a **bot
  token**, so it can edit a message in place across the lifecycle. An incoming
  **webhook** is supported as a one-shot fallback (webhooks can't edit, so it
  only fires on `deploying`).
- **Discord** uses a **webhook** — it creates with `?wait=true` (which returns
  the message id) and edits via `PATCH .../messages/{id}`. No bot required.
- The changelog markdown is rendered to **Slack Block Kit** and a **Discord
  embed** (with the platform limits respected — field/length/total truncation).
- Zero runtime dependencies: a single `notify.js` using Node 20's global
  `fetch`. Tests run with `node --test`.

## Lifecycle usage (edit one message across a deploy)

Keep all three steps in one job so the message refs flow through step outputs —
no committing state back to the repo:

```yaml
- name: Notify deploying
  id: notify
  uses: ten-thousand-hammers/changelog-notify@v1
  with:
    status: deploying
    version: ${{ github.event.release.tag_name }}
    changes: ${{ github.event.release.body }}
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    slack-channel: ${{ secrets.SLACK_CHANNEL }}
    discord-webhook: ${{ secrets.DISCORD_WEBHOOK }}
    fail-on-error: false

- run: ./deploy.sh

- name: Notify released
  if: success()
  uses: ten-thousand-hammers/changelog-notify@v1
  with:
    status: released
    version: ${{ github.event.release.tag_name }}
    changes: ${{ github.event.release.body }}
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    slack-channel: ${{ secrets.SLACK_CHANNEL }}
    slack-ts: ${{ steps.notify.outputs.slack-ts }}
    discord-webhook: ${{ secrets.DISCORD_WEBHOOK }}
    discord-message-id: ${{ steps.notify.outputs.discord-message-id }}
    fail-on-error: false

- name: Notify failed
  if: failure()
  uses: ten-thousand-hammers/changelog-notify@v1
  with:
    status: failed
    version: ${{ github.event.release.tag_name }}
    changes: ${{ github.event.release.body }}
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    slack-channel: ${{ secrets.SLACK_CHANNEL }}
    slack-ts: ${{ steps.notify.outputs.slack-ts }}
    discord-webhook: ${{ secrets.DISCORD_WEBHOOK }}
    discord-message-id: ${{ steps.notify.outputs.discord-message-id }}
    fail-on-error: false
```

See [`examples/fly-deploy-lifecycle.yml`](examples/fly-deploy-lifecycle.yml).

## Cross-run persistence (`state-file`)

If the lifecycle spans **separate workflow runs** (e.g. post on release-created,
edit on a later deploy run), pass a `state-file`. The action reads it on entry to
recover the refs and writes it on create. It does **not** commit — committing the
file is up to your workflow (matching the platform's `config/deploys/{version}.ts`
pattern; legacy bare-`ts` files are still understood).

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `status` | _(required)_ | `deploying` \| `released` \| `failed`. |
| `version` | _(required)_ | Version/tag, e.g. `2026.6.4+1`. |
| `changes` | `""` | Release notes body (raw changelog markdown). |
| `app-name` | repo name | Display name. |
| `slack-bot-token` | `""` | Slack bot token — enables the Slack lifecycle. |
| `slack-channel` | `""` | Slack channel ID (required with the bot token). |
| `slack-webhook` | `""` | Slack incoming webhook (one-shot fallback). |
| `slack-ts` | `""` | Existing Slack `ts` to edit. |
| `discord-webhook` | `""` | Discord webhook URL — enables Discord. |
| `discord-message-id` | `""` | Existing Discord message id to edit. |
| `state-file` | `""` | Optional JSON file for cross-run ref persistence. |
| `color-deploying` / `color-released` / `color-failed` | `dbab09` / `28a745` / `FF5733` | Hex colors per status. |
| `status-label-deploying` / `-released` / `-failed` | `Deploying` / `Released` / `Deploy failed` | Status label text. |
| `fail-on-error` | `"true"` | Fail the step when delivery fails. Set `false` so a flaky notification never red-Xes a successful deploy. |

## Outputs

| Name | Description |
| --- | --- |
| `slack-ts` | Slack message `ts` (feed into a later step's `slack-ts`). |
| `discord-message-id` | Discord message id (feed into a later step's `discord-message-id`). |
| `slack-delivered` / `discord-delivered` | `'true'`/`'false'` per provider. |

## Setup

- **Slack:** create a bot with `chat:write`, invite it to the channel, store the
  token as `SLACK_BOT_TOKEN` and the channel **ID** as `SLACK_CHANNEL`.
- **Discord:** Server Settings → Integrations → Webhooks → New Webhook, copy the
  URL into `DISCORD_WEBHOOK`.

## Notes & limits

- If neither Slack nor Discord is configured, the action is a no-op success — safe
  to drop into a repo before secrets are set.
- Each provider runs independently; one failing won't block the other.
- If the initial `deploying` post fails, later `released`/`failed` steps have no
  ref to edit and will post a fresh message instead.
- Discord embeds are capped (≤25 fields, ≤1024 chars/field, ≤4096 description,
  ≤6000 total) and truncated gracefully; Slack section text is kept under 3000.
- Don't log secrets — token/webhook values are auto-masked by Actions.

## Development

```sh
node --test
```
