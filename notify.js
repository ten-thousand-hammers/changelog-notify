"use strict";

const fs = require("node:fs");
const { formatChangelog } = require("./format.js");

const DEFAULT_COLORS = {
  deploying: "dbab09",
  released: "28a745",
  failed: "FF5733",
};
const DEFAULT_LABELS = {
  deploying: "Deploying",
  released: "Released",
  failed: "Deploy failed",
};

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : v;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  let data = "";
  for (const [key, value] of Object.entries(outputs)) {
    data += `${key}=${value}\n`;
  }
  fs.appendFileSync(file, data);
}

// Slack Web API returns HTTP 200 even on failure, so we must inspect `ok`.
async function postSlack({ token, channel, ts, fmt }) {
  const editing = Boolean(ts);
  const method = editing ? "chat.update" : "chat.postMessage";
  const body = {
    channel,
    text: fmt.slackText,
    blocks: fmt.slackBlocks,
    attachments: fmt.slackAttachments,
  };
  if (editing) body.ts = ts;

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error || `HTTP ${res.status}`}`);
  }
  return json.ts || ts;
}

async function postSlackWebhook({ url, fmt }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: fmt.slackText,
      blocks: fmt.slackBlocks,
      attachments: fmt.slackAttachments,
    }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
}

// Discord webhooks: create with ?wait=true (returns the message, incl. id),
// edit via PATCH /messages/{id}. Honour a single 429 retry.
async function postDiscord({ webhook, messageId, fmt, retried = false }) {
  const payload = JSON.stringify({
    content: fmt.discordContent,
    embeds: [fmt.discordEmbed],
  });

  let res;
  if (messageId) {
    res = await fetch(`${webhook}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } else {
    const url = new URL(webhook);
    url.searchParams.set("wait", "true");
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  }

  if (res.status === 429 && !retried) {
    const info = await res.json().catch(() => ({}));
    const waitMs = (Number(info.retry_after) || 1) * 1000 + 250;
    await sleep(waitMs);
    return postDiscord({ webhook, messageId, fmt, retried: true });
  }
  if (!res.ok) {
    throw new Error(`Discord ${messageId ? "edit" : "create"} failed: HTTP ${res.status}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.id || messageId;
}

async function run() {
  const status = env("STATUS") || "released";
  const version = env("VERSION");
  const appName = env("APP_NAME") || version || "App";
  const changes = env("CHANGES");
  const upper = status.toUpperCase();
  const color = env(`COLOR_${upper}`) || DEFAULT_COLORS[status] || "cccccc";
  const statusLabel = env(`LABEL_${upper}`) || DEFAULT_LABELS[status] || status;

  // Resolve message refs: explicit input wins, then state-file, then none.
  let slackTs = env("SLACK_TS").trim();
  let discordMessageId = env("DISCORD_MESSAGE_ID").trim();
  const stateFile = env("STATE_FILE");
  if (stateFile && fs.existsSync(stateFile)) {
    const raw = fs.readFileSync(stateFile, "utf8").trim();
    let state;
    try {
      const parsed = JSON.parse(raw);
      // A bare Slack ts ("1700000000.123") is valid JSON (a number), so only
      // trust an object; otherwise treat the file as a legacy bare-ts (platform compat).
      state = parsed && typeof parsed === "object" ? parsed : { slackTs: raw };
    } catch {
      state = { slackTs: raw };
    }
    if (!slackTs) slackTs = state.slackTs || "";
    if (!discordMessageId) discordMessageId = state.discordMessageId || "";
  }

  // Trim to tolerate stray whitespace/newlines in secrets — a common cause of
  // Slack "invalid_auth" when the token otherwise looks correct.
  let slackToken = env("SLACK_BOT_TOKEN").trim();
  const slackChannel = env("SLACK_CHANNEL").trim();
  let slackWebhook = env("SLACK_WEBHOOK").trim();
  const discordWebhook = env("DISCORD_WEBHOOK").trim();

  // Tolerate a Slack incoming-webhook URL placed in the bot-token slot: bot
  // tokens start with "xoxb-", so an https:// value is unambiguously a webhook.
  if (slackToken.startsWith("https://")) {
    if (!slackWebhook) slackWebhook = slackToken;
    slackToken = "";
  }

  const useSlackBot = Boolean(slackToken && slackChannel);
  const useSlackWebhook = Boolean(!useSlackBot && slackWebhook);
  const useDiscord = Boolean(discordWebhook);

  const errors = [];
  let slackDelivered = false;
  let discordDelivered = false;

  if (!useSlackBot && !useSlackWebhook && !useDiscord) {
    console.log("changelog-notify: no providers configured, skipping.");
    writeOutputs({
      "slack-ts": slackTs,
      "discord-message-id": discordMessageId,
      "slack-delivered": false,
      "discord-delivered": false,
    });
    return { slackTs, discordMessageId, slackDelivered, discordDelivered, errors: [] };
  }

  const fmt = formatChangelog(changes, {
    appName,
    version,
    status,
    color,
    statusLabel,
  });

  if (useSlackBot) {
    try {
      slackTs = await postSlack({
        token: slackToken,
        channel: slackChannel,
        ts: slackTs,
        fmt,
      });
      slackDelivered = true;
    } catch (e) {
      errors.push(e);
    }
  } else if (useSlackWebhook) {
    // Incoming webhooks can't edit a prior message, so each status posts as its
    // own message (e.g. "deploying" then "released"/"failed"). Use a bot token
    // if you want a single message edited in place across the lifecycle.
    try {
      await postSlackWebhook({ url: slackWebhook, fmt });
      slackDelivered = true;
    } catch (e) {
      errors.push(e);
    }
  }

  if (useDiscord) {
    try {
      discordMessageId = await postDiscord({
        webhook: discordWebhook,
        messageId: discordMessageId,
        fmt,
      });
      discordDelivered = true;
    } catch (e) {
      errors.push(e);
    }
  }

  if (stateFile && (slackTs || discordMessageId)) {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ slackTs, discordMessageId }) + "\n"
    );
  }

  writeOutputs({
    "slack-ts": slackTs,
    "discord-message-id": discordMessageId,
    "slack-delivered": slackDelivered,
    "discord-delivered": discordDelivered,
  });

  return {
    slackTs,
    discordMessageId,
    slackDelivered,
    discordDelivered,
    errors: errors.map((e) => e.message),
  };
}

if (require.main === module) {
  run()
    .then((res) => {
      if (res.errors && res.errors.length) {
        for (const message of res.errors) console.error(`::error::${message}`);
        if (process.env.FAIL_ON_ERROR !== "false") process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error(`::error::${e.message}`);
      process.exitCode = 1;
    });
} else {
  module.exports = { run, postSlack, postDiscord, postSlackWebhook };
}
