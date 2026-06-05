const { test } = require("node:test");
const assert = require("node:assert");
const {
  formatChangelog,
  hexToInt,
  parseSections,
  limits,
} = require("./format");

const CHANGES = `### ✨ Changed
- Add session model test coverage

### 🐛 Fixed
- Fail image tests when the URL is invalid`;

const opts = (over = {}) => ({
  appName: "demo",
  version: "1.0.0",
  status: "released",
  color: "28a745",
  statusLabel: "Released",
  ...over,
});

test("slack: header block plus one section per category", () => {
  const out = formatChangelog(CHANGES, opts({ status: "deploying", color: "dbab09", statusLabel: "Deploying" }));
  assert.strictEqual(out.slackBlocks[0].type, "header");
  assert.strictEqual(out.slackBlocks[0].text.text, "demo 1.0.0 Release Notes");

  const sections = out.slackBlocks.filter((b) => b.type === "section");
  assert.strictEqual(sections.length, 2);
  assert.ok(sections[0].text.text.startsWith("*✨ Changed*"));
  assert.ok(sections[0].text.text.includes("- Add session model test coverage"));

  assert.strictEqual(out.slackAttachments[0].color, "dbab09");
  assert.strictEqual(out.slackAttachments[0].fields[0].value, "Deploying");
});

test("discord: embed with one field per category and decimal color", () => {
  const out = formatChangelog(CHANGES, opts());
  assert.strictEqual(out.discordEmbed.title, "demo 1.0.0 Release Notes");
  assert.strictEqual(out.discordEmbed.color, 0x28a745);
  assert.strictEqual(out.discordEmbed.fields.length, 2);
  assert.strictEqual(out.discordEmbed.fields[0].name, "✨ Changed");
  assert.ok(out.discordEmbed.fields[0].value.includes("- Add session model test coverage"));
  assert.strictEqual(out.discordEmbed.footer.text, "Status: Released");
});

test("hexToInt converts colors (and strips a leading #)", () => {
  assert.strictEqual(hexToInt("28a745"), 0x28a745);
  assert.strictEqual(hexToInt("FF5733"), 0xff5733);
  assert.strictEqual(hexToInt("#dbab09"), 0xdbab09);
});

test("#### subheaders become slack *bold* and discord **bold**", () => {
  const multi = "### Update Datadog\n\n#### ✨ Changed\n- one";
  const out = formatChangelog(multi, opts());
  const section = out.slackBlocks.find((b) => b.type === "section");
  assert.ok(section.text.text.includes("*✨ Changed*"));
  assert.ok(!section.text.text.includes("#### "));
  assert.ok(out.discordEmbed.fields[0].value.includes("**✨ Changed**"));
  assert.ok(!out.discordEmbed.fields[0].value.includes("#### "));
});

test("empty changes yields header/title only, no sections or fields", () => {
  const out = formatChangelog("", opts());
  assert.strictEqual(out.slackBlocks.length, 1);
  assert.strictEqual(out.slackBlocks[0].type, "header");
  assert.strictEqual(out.discordEmbed.fields.length, 0);
});

test("scaffolding headers are dropped", () => {
  const withScaffold = "# Changelog\n\n## [Unreleased]\n\n### 🚀 Added\n- thing";
  const { sections } = parseSections(withScaffold);
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(sections[0].header, "🚀 Added");
});

test("discord: long field value truncated to <= 1024", () => {
  const big = "### Big\n" + Array.from({ length: 200 }, (_, i) => `- item ${i} ${"x".repeat(20)}`).join("\n");
  const out = formatChangelog(big, opts());
  assert.ok(out.discordEmbed.fields[0].value.length <= limits.DISCORD_FIELD_VALUE_MAX);
});

test("discord: more than 25 categories capped to <= 25 fields with overflow note", () => {
  let body = "";
  for (let i = 0; i < 30; i += 1) body += `### Cat ${i}\n- item\n\n`;
  const out = formatChangelog(body, opts());
  assert.ok(out.discordEmbed.fields.length <= limits.DISCORD_FIELDS_MAX);
  const last = out.discordEmbed.fields[out.discordEmbed.fields.length - 1];
  assert.ok(last.value.includes("more"));
});

test("discord: total embed kept under 6000", () => {
  let body = "";
  for (let i = 0; i < 24; i += 1) body += `### Cat ${i}\n- ${"y".repeat(900)}\n\n`;
  const out = formatChangelog(body, opts());
  const e = out.discordEmbed;
  const total =
    e.title.length +
    (e.description || "").length +
    e.footer.text.length +
    e.fields.reduce((acc, f) => acc + f.name.length + f.value.length, 0);
  assert.ok(total <= limits.DISCORD_TOTAL_MAX, `embed total ${total} exceeds cap`);
});

test("slack: section text truncated under the 3000 hard limit", () => {
  const body = "### Big\n- " + "z".repeat(5000);
  const out = formatChangelog(body, opts());
  const section = out.slackBlocks.find((b) => b.type === "section");
  assert.ok(section.text.text.length <= 3000);
});

test("slackText / discordContent use the status verb", () => {
  const dep = formatChangelog("", opts({ status: "deploying", statusLabel: "Deploying" }));
  assert.strictEqual(dep.slackText, "demo 1.0.0 is deploying");
  assert.strictEqual(dep.discordContent, "demo 1.0.0 is deploying");

  const fail = formatChangelog("", opts({ status: "failed", statusLabel: "Deploy failed" }));
  assert.strictEqual(fail.slackText, "demo 1.0.0 Deploy failed");
});
