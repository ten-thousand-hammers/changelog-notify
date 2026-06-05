const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("./notify");

const ENV_KEYS = [
  "STATUS", "VERSION", "CHANGES", "APP_NAME",
  "SLACK_BOT_TOKEN", "SLACK_CHANNEL", "SLACK_WEBHOOK", "SLACK_TS",
  "DISCORD_WEBHOOK", "DISCORD_MESSAGE_ID", "STATE_FILE",
  "COLOR_DEPLOYING", "COLOR_RELEASED", "COLOR_FAILED",
  "LABEL_DEPLOYING", "LABEL_RELEASED", "LABEL_FAILED",
  "FAIL_ON_ERROR", "GITHUB_OUTPUT",
];

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1/abc";

let savedFetch;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = global.fetch;
});

afterEach(() => {
  global.fetch = savedFetch;
});

function setEnv(obj) {
  for (const [k, v] of Object.entries(obj)) process.env[k] = String(v);
}

function makeResponse({ status = 200, json = {}, text = "" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => json,
    text: async () => text,
  };
}

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({
      url: u,
      method: opts.method,
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return makeResponse(handler(u, opts, calls.length - 1) || {});
  };
  return calls;
}

test("slack: posts a new message and returns ts", async () => {
  setEnv({
    STATUS: "deploying",
    VERSION: "1.0.0",
    APP_NAME: "demo",
    CHANGES: "### 🚀 Added\n- thing",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL: "C123",
  });
  const calls = mockFetch((url) =>
    url.includes("chat.postMessage") ? { json: { ok: true, ts: "111.222" } } : { json: { ok: true } }
  );
  const res = await run();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes("chat.postMessage"));
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].headers.Authorization, "Bearer xoxb-test");
  assert.strictEqual(calls[0].body.channel, "C123");
  assert.strictEqual(res.slackTs, "111.222");
  assert.strictEqual(res.slackDelivered, true);
  assert.strictEqual(res.discordDelivered, false);
  assert.deepStrictEqual(res.errors, []);
});

test("slack: edits with chat.update when a ts is provided", async () => {
  setEnv({
    STATUS: "released",
    VERSION: "1.0.0",
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_CHANNEL: "C1",
    SLACK_TS: "999.000",
  });
  const calls = mockFetch(() => ({ json: { ok: true, ts: "999.000" } }));
  const res = await run();
  assert.ok(calls[0].url.includes("chat.update"));
  assert.strictEqual(calls[0].body.ts, "999.000");
  assert.strictEqual(res.slackTs, "999.000");
});

test("slack: {ok:false} surfaces an error and does not deliver", async () => {
  setEnv({ STATUS: "deploying", VERSION: "1.0.0", SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1" });
  mockFetch(() => ({ status: 200, json: { ok: false, error: "channel_not_found" } }));
  const res = await run();
  assert.strictEqual(res.slackDelivered, false);
  assert.strictEqual(res.errors.length, 1);
  assert.ok(res.errors[0].includes("channel_not_found"));
});

test("discord: posts with ?wait=true and returns the message id", async () => {
  setEnv({
    STATUS: "deploying",
    VERSION: "1.0.0",
    DISCORD_WEBHOOK,
    CHANGES: "### 🐛 Fixed\n- bug",
  });
  const calls = mockFetch(() => ({ json: { id: "555" } }));
  const res = await run();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes("wait=true"));
  assert.strictEqual(calls[0].method, "POST");
  assert.ok(Array.isArray(calls[0].body.embeds));
  assert.strictEqual(res.discordMessageId, "555");
  assert.strictEqual(res.discordDelivered, true);
});

test("discord: edits via PATCH /messages/{id} when an id is provided", async () => {
  setEnv({ STATUS: "released", VERSION: "1.0.0", DISCORD_WEBHOOK, DISCORD_MESSAGE_ID: "555" });
  const calls = mockFetch(() => ({ json: { id: "555" } }));
  const res = await run();
  assert.strictEqual(calls[0].method, "PATCH");
  assert.ok(calls[0].url.endsWith("/messages/555"));
  assert.strictEqual(res.discordMessageId, "555");
});

test("discord: non-2xx surfaces an error", async () => {
  setEnv({ STATUS: "deploying", VERSION: "1.0.0", DISCORD_WEBHOOK });
  mockFetch(() => ({ status: 400, text: "bad request" }));
  const res = await run();
  assert.strictEqual(res.discordDelivered, false);
  assert.strictEqual(res.errors.length, 1);
  assert.ok(res.errors[0].includes("400"));
});

test("discord: retries once on 429 then succeeds", async () => {
  setEnv({ STATUS: "deploying", VERSION: "1.0.0", DISCORD_WEBHOOK });
  let n = 0;
  const calls = mockFetch(() => {
    n += 1;
    return n === 1 ? { status: 429, json: { retry_after: 0.01 } } : { json: { id: "777" } };
  });
  const res = await run();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(res.discordMessageId, "777");
  assert.strictEqual(res.discordDelivered, true);
});

test("both providers: one failing does not block the other", async () => {
  setEnv({
    STATUS: "deploying",
    VERSION: "1.0.0",
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_CHANNEL: "C1",
    DISCORD_WEBHOOK,
  });
  const calls = mockFetch((url) =>
    url.includes("slack.com") ? { json: { ok: true, ts: "1.2" } } : { status: 500, text: "err" }
  );
  const res = await run();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(res.slackDelivered, true);
  assert.strictEqual(res.discordDelivered, false);
  assert.strictEqual(res.errors.length, 1);
});

test("no providers configured: no-op, no fetch calls", async () => {
  setEnv({ STATUS: "released", VERSION: "1.0.0" });
  const calls = mockFetch(() => ({ json: {} }));
  const res = await run();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.slackDelivered, false);
  assert.strictEqual(res.discordDelivered, false);
  assert.deepStrictEqual(res.errors, []);
});

test("slack webhook: posts on deploying", async () => {
  setEnv({ STATUS: "deploying", VERSION: "1.0.0", SLACK_WEBHOOK: "https://hooks.slack.com/x" });
  const calls = mockFetch(() => ({ status: 200, json: {} }));
  const res = await run();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(res.slackDelivered, true);
});

test("slack webhook: skips non-deploying statuses (cannot edit)", async () => {
  setEnv({ STATUS: "released", VERSION: "1.0.0", SLACK_WEBHOOK: "https://hooks.slack.com/x" });
  const calls = mockFetch(() => ({ status: 200, json: {} }));
  const res = await run();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(res.slackDelivered, false);
});

test("state-file: writes refs on create, then edits on a later run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  const stateFile = path.join(dir, "state.json");

  setEnv({ STATUS: "deploying", VERSION: "1.0.0", DISCORD_WEBHOOK, STATE_FILE: stateFile });
  mockFetch(() => ({ json: { id: "abc123" } }));
  await run();
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.strictEqual(saved.discordMessageId, "abc123");

  for (const k of ENV_KEYS) delete process.env[k];
  setEnv({ STATUS: "released", VERSION: "1.0.0", DISCORD_WEBHOOK, STATE_FILE: stateFile });
  const calls = mockFetch(() => ({ json: { id: "abc123" } }));
  await run();
  assert.strictEqual(calls[0].method, "PATCH");
  assert.ok(calls[0].url.endsWith("/messages/abc123"));

  fs.rmSync(dir, { recursive: true });
});

test("state-file: legacy bare ts is parsed as slackTs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  const stateFile = path.join(dir, "1.0.0.ts");
  fs.writeFileSync(stateFile, "1700000000.123\n");

  setEnv({ STATUS: "released", VERSION: "1.0.0", SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1", STATE_FILE: stateFile });
  const calls = mockFetch(() => ({ json: { ok: true, ts: "1700000000.123" } }));
  await run();
  assert.ok(calls[0].url.includes("chat.update"));
  assert.strictEqual(calls[0].body.ts, "1700000000.123");

  fs.rmSync(dir, { recursive: true });
});

test("writes step outputs to GITHUB_OUTPUT", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-out-"));
  const outFile = path.join(dir, "out.txt");
  setEnv({
    STATUS: "deploying",
    VERSION: "1.0.0",
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_CHANNEL: "C1",
    GITHUB_OUTPUT: outFile,
  });
  mockFetch(() => ({ json: { ok: true, ts: "42.42" } }));
  await run();
  const written = fs.readFileSync(outFile, "utf8");
  assert.ok(written.includes("slack-ts=42.42"));
  assert.ok(written.includes("slack-delivered=true"));
  assert.ok(written.includes("discord-delivered=false"));
  fs.rmSync(dir, { recursive: true });
});
