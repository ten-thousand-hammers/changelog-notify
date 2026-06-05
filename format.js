"use strict";

// Slack limits (with headroom under the hard caps).
const SLACK_SECTION_MAX = 2900; // hard limit 3000 chars per section text
const SLACK_MAX_BLOCKS = 45; // hard limit 50 blocks

// Discord limits.
const DISCORD_TITLE_MAX = 256;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_FIELDS_MAX = 25;
const DISCORD_DESC_MAX = 4096;
const DISCORD_TOTAL_MAX = 6000;
const DISCORD_CONTENT_MAX = 2000;

const STATUS_VERB = {
  deploying: "is deploying",
  released: "Released",
  failed: "Deploy failed",
};

function truncate(str, max, suffix = "… (truncated)") {
  const s = String(str == null ? "" : str);
  if (s.length <= max) return s;
  if (max <= suffix.length) return suffix.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

function hexToInt(hex) {
  const n = parseInt(String(hex).replace(/^#/, ""), 16);
  return Number.isNaN(n) ? 0 : n;
}

// Split a changelog markdown body into { preamble, sections }, where each
// section is the content under a `### ` heading. The raw body is preserved so
// each provider can apply its own `#### ` -> bold transform. Scaffolding lines
// ("# Changelog", "## [Unreleased]") are dropped.
function parseSections(changes) {
  const text = String(changes == null ? "" : changes).replace(/\r\n/g, "\n");
  const cleaned = text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== "# Changelog" && !/^##\s+\[/.test(t);
    })
    .join("\n");

  const parts = cleaned.split(/(?=^### )/m).filter((p) => p.trim());
  const sections = [];
  let preamble = "";
  for (const part of parts) {
    if (/^### /.test(part)) {
      const lines = part.replace(/\n+$/, "").split("\n");
      const header = lines[0].replace(/^###\s+/, "").trim();
      const body = lines.slice(1).join("\n").trim();
      sections.push({ header, body });
    } else {
      preamble += part;
    }
  }
  return { preamble: preamble.trim(), sections };
}

function buildSlack(sections, ctx) {
  const { appName, version, color, statusLabel, statusVerb } = ctx;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${appName} ${version} Release Notes` },
    },
  ];
  for (const { header, body } of sections) {
    if (blocks.length >= SLACK_MAX_BLOCKS) break;
    const slackBody = body.replace(/^####\s+(.+)$/gm, "*$1*");
    const text = truncate(`*${header}*\n${slackBody}`.trim(), SLACK_SECTION_MAX);
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }
  const attachments = [
    { color, fields: [{ title: "Status", short: true, value: statusLabel }] },
  ];
  return { blocks, attachments, text: `${appName} ${version} ${statusVerb}` };
}

function embedTotal(embed) {
  let total = (embed.title || "").length + (embed.description || "").length;
  total += (embed.footer && embed.footer.text ? embed.footer.text.length : 0);
  for (const f of embed.fields) total += (f.name || "").length + (f.value || "").length;
  return total;
}

// Greedily trim the longest field value until the embed is under the total cap.
function enforceEmbedTotal(embed) {
  let guard = 0;
  while (embedTotal(embed) > DISCORD_TOTAL_MAX && guard < 2000) {
    guard += 1;
    let idx = -1;
    let longest = -1;
    for (let i = 0; i < embed.fields.length; i += 1) {
      const len = (embed.fields[i].value || "").length;
      if (len > longest) {
        longest = len;
        idx = i;
      }
    }
    if (idx === -1 || longest <= 1) break;
    const over = embedTotal(embed) - DISCORD_TOTAL_MAX;
    const target = Math.max(1, longest - Math.max(16, over + 16));
    embed.fields[idx].value = truncate(embed.fields[idx].value, target);
  }
}

function buildDiscord(preamble, sections, ctx) {
  const { appName, version, color, statusLabel, statusVerb } = ctx;
  const embed = {
    title: truncate(`${appName} ${version} Release Notes`, DISCORD_TITLE_MAX),
    color: hexToInt(color),
    fields: [],
    footer: { text: `Status: ${statusLabel}` },
  };
  if (preamble) embed.description = truncate(preamble, DISCORD_DESC_MAX);

  let list = sections;
  let omitted = 0;
  if (sections.length > DISCORD_FIELDS_MAX) {
    list = sections.slice(0, DISCORD_FIELDS_MAX - 1);
    omitted = sections.length - list.length;
  }
  for (const { header, body } of list) {
    const value = body.replace(/^####\s+(.+)$/gm, "**$1**").trim() || "—";
    embed.fields.push({
      name: truncate(header || "—", DISCORD_FIELD_NAME_MAX),
      value: truncate(value, DISCORD_FIELD_VALUE_MAX),
      inline: false,
    });
  }
  if (omitted > 0) {
    embed.fields.push({ name: "…", value: `and ${omitted} more`, inline: false });
  }

  enforceEmbedTotal(embed);

  return {
    embed,
    content: truncate(`${appName} ${version} ${statusVerb}`, DISCORD_CONTENT_MAX),
  };
}

// Produce Slack Block Kit and Discord embed payloads from one changelog body.
function formatChangelog(changes, opts = {}) {
  const {
    appName = "App",
    version = "",
    status = "released",
    color = "cccccc",
    statusLabel = status,
  } = opts;
  const ctx = {
    appName,
    version,
    color,
    statusLabel,
    statusVerb: STATUS_VERB[status] || status,
  };
  const { preamble, sections } = parseSections(changes);
  const slack = buildSlack(sections, ctx);
  const discord = buildDiscord(preamble, sections, ctx);
  return {
    slackBlocks: slack.blocks,
    slackAttachments: slack.attachments,
    slackText: slack.text,
    discordEmbed: discord.embed,
    discordContent: discord.content,
  };
}

module.exports = {
  formatChangelog,
  parseSections,
  hexToInt,
  truncate,
  STATUS_VERB,
  limits: {
    SLACK_SECTION_MAX,
    SLACK_MAX_BLOCKS,
    DISCORD_FIELD_VALUE_MAX,
    DISCORD_FIELDS_MAX,
    DISCORD_DESC_MAX,
    DISCORD_TOTAL_MAX,
    DISCORD_CONTENT_MAX,
  },
};
