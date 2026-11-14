import assert from "node:assert/strict";
import test from "node:test";
import { _internal } from "../index.mjs";

const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const usageURL = "https://api.anthropic.com/api/oauth/usage";
const start = Date.parse("2026-11-03T20:00:00Z");
const row = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
const windows = (five = 25, week = 50) => ({
  five_hour: { utilization: five, resets_at: "2026-11-04T00:00:00Z" },
  seven_day: { utilization: week, resets_at: "2026-11-10T00:00:00Z" },
});
const grant = (extra = {}) => ({ id: "fable-launch", resets_total: 1, resets_left: 1, type: "weekly",
  starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-30T00:00:00Z", ...extra });
const cedar = (grants = [grant()]) => ({ eligible: true, grants });
const envelope = (body, status_code = 200, header) => ({ status_code, body: JSON.stringify(body), ...(header ? { header } : {}) });
// What CPA keeps from the credential's latest inference response (canonical Go header keys).
const signals = (at, extra = {}) => ({ observed_at: new Date(at).toISOString(), signals: {
  "Anthropic-Ratelimit-Unified-Status": "allowed",
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
  "Anthropic-Ratelimit-Unified-5h-Reset": String(Date.parse("2026-11-04T01:00:00Z") / 1000),
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.17",
  "Anthropic-Ratelimit-Unified-7d-Reset": "1794700800.4",
  ...extra,
} });
const signalWindows = [
  { name: "5 hours", used: 42, span: 18000, resetsAt: "2026-11-04T01:00:00.000Z" },
  { name: "7 days", used: 17, span: 604800, resetsAt: "2026-11-15T00:00:00.400Z" },
];

function harness({ usage = envelope({ ...windows(), cedar_ember: cedar() }), files } = {}) {
  let clock = start;
  const calls = [];
  const h = { usage, plain: envelope(windows()), files: files ?? [row], calls, advance: ms => { clock += ms; },
    now: () => clock };
  h.read = _internal.createUsage({ now: () => clock, request: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/credentials")) return Response.json({ files: typeof h.files === "function" ? h.files() : h.files });
    if (h.gate) await h.gate;
    return Response.json(body.url === usageURL ? h.plain : h.usage);
  } });
  h.get = (credential) => h.read(() => ({ type: "api", key: "test-biz-key",
    metadata: { baseURL, managementKey, ...(credential ? { credential } : {}) } }));
  h.inner = () => calls.filter(call => call.url.endsWith("/requests/api-call")).map(call => call.body.url);
  return h;
}

test("selections naming one credential share its upstream read, in flight and cached", async () => {
  const h = harness();
  let release;
  h.gate = new Promise(resolve => { release = resolve; });
  const pending = [h.get(), h.get("one"), h.get("index-one")];
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  for (const result of await Promise.all(pending)) assert.equal(result.windows[0].used, 25);
  assert.equal(h.inner().length, 1);
  assert.equal(h.calls.filter(call => call.url.endsWith("/credentials")).length, 1);
});

test("shared readings are copied before the multi-credential label is added", async () => {
  const h = harness({ files: [row, { ...row, provider: "other", auth_index: "x", name: "x" }] });
  for (const credential of ["one", "index-one", "one"]) {
    assert.deepEqual((await h.get(credential)).windows.map(w => w.name),
      ["5 hours (Claude First)", "7 days (Claude First)"]);
  }
  assert.equal(h.inner().length, 1);
});

test("recent CPA quota signals supply the windows without another Anthropic read", async () => {
  const h = harness();
  h.files = () => [{ ...row, quota: signals(h.now() - 60_000) }];
  // The first read still asks Anthropic once, for the reset inventory.
  const first = await h.get();
  assert.equal(h.inner().length, 1);
  assert.equal(first.resets.count, 1);
  for (let elapsed = 300_000; elapsed < 1_800_000; elapsed += 300_000) {
    h.advance(300_000);
    const result = await h.get();
    assert.deepEqual(result.windows, signalWindows);
    assert.equal(result.resets.count, 1, "the cached inventory stays with the passive windows");
  }
  assert.equal(h.inner().length, 1);
  // After 30 minutes the inventory is read again, then the signals carry on.
  h.advance(300_000);
  h.usage = envelope({ ...windows(), cedar_ember: cedar([grant(), grant({ id: "second" })]) });
  assert.equal((await h.get()).resets.count, 2);
  assert.equal(h.inner().length, 2);
});

test("signals newer than a cached read replace its windows; old, partial or odd signals are ignored", async () => {
  const h = harness();
  assert.equal((await h.get()).windows[0].used, 25);
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  h.advance(60_000);
  assert.equal((await h.get()).windows[0].used, 25, "selection cache still holds");
  h.advance(240_000);
  assert.deepEqual((await h.get()).windows, signalWindows);
  assert.equal(h.inner().length, 1);
  const bad = [
    at => signals(at - 300_001), at => signals(at + 60_001), at => ({ observed_at: "soon", signals: {} }),
    at => signals(at, { "Anthropic-Ratelimit-Unified-7d-Utilization": undefined }),
    at => signals(at, { "Anthropic-Ratelimit-Unified-5h-Utilization": "-0.1" }),
    at => signals(at, { "Anthropic-Ratelimit-Unified-5h-Utilization": "1e3" }),
    at => signals(at, { "Anthropic-Ratelimit-Unified-5h-Reset": String(at / 1000) }),
    at => signals(at, { "Anthropic-Ratelimit-Unified-5h-Reset": "9".repeat(20) }),
    at => ({ observed_at: new Date(at).toISOString(), signals: null }),
  ];
  for (const quota of bad) {
    const one = harness();
    one.files = () => [{ ...row, quota: quota(one.now()) }];
    assert.equal((await one.get()).windows[0].used, 25);
    one.advance(300_000);
    assert.equal((await one.get()).windows[0].used, 25);
    assert.equal(one.inner().length, 2, JSON.stringify(quota(one.now())));
  }
});

test("a credential whose opt-in query is refused reads the plain URL for a day, and signals then suffice", async () => {
  const h = harness({ usage: envelope({}, 403) });
  await h.get();
  assert.deepEqual(h.inner(), [usageURL + "?cedar_ember=1", usageURL]);
  h.advance(300_000);
  await h.get();
  assert.deepEqual(h.inner().slice(2), [usageURL]);
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  for (let i = 0; i < 12; i++) { h.advance(300_000); assert.deepEqual((await h.get()).windows, signalWindows); }
  assert.equal(h.inner().length, 3, "no inventory to refresh, so no Anthropic read at all");
  h.files = [row];
  h.advance(86_400_000);
  await h.get();
  assert.deepEqual(h.inner().slice(3), [usageURL + "?cedar_ember=1", usageURL]);
});

test("upstream 429 honours Retry-After and repeated failures double the pause up to an hour", async () => {
  const h = harness({ usage: envelope({}, 429, { "Retry-After": ["1800"] }) });
  const result = await h.get();
  assert.match(result.error, /rate-limited/);
  for (let i = 0; i < 5; i++) { h.advance(300_000); assert.equal(typeof (await h.get()).error, "string"); }
  assert.equal(h.inner().length, 1, "no Anthropic request inside Retry-After");
  h.usage = envelope({}, 500);
  h.advance(300_000);
  await h.get();
  assert.equal(h.inner().length, 2);
  const gaps = [];
  let last = h.now();
  for (let i = 0; i < 60; i++) {
    h.advance(300_000);
    const before = h.inner().length;
    await h.get();
    if (h.inner().length > before) { gaps.push(h.now() - last); last = h.now(); }
  }
  // Failures 2..: 600s, 1200s, 2400s, then the 3600s cap.
  assert.deepEqual(gaps.slice(0, 5), [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  h.usage = envelope(windows(5));
  h.advance(3_600_000);
  assert.equal((await h.get()).windows[0].used, 5);
});

test("an HTTP-date Retry-After counts too; past or invalid values fall back to the backoff", async () => {
  for (const [header, expected] of [[{ "retry-after": [new Date(start + 2_700_000).toUTCString()] }, 2_700_000],
    [{ "Retry-After": ["0"] }, 300_000], [{ "Retry-After": ["later"] }, 300_000], [undefined, 300_000],
    [{ "Retry-After": ["99999999"] }, 3_600_000]]) {
    const h = harness({ usage: envelope({}, 429, header) });
    await h.get();
    h.advance(expected - 1);
    await h.get();
    assert.equal(h.inner().length, 1);
    h.advance(300_000);
    await h.get();
    assert.equal(h.inner().length, 2, JSON.stringify(header));
  }
});

test("an upstream failure falls back to recent CPA signals instead of an error", async () => {
  const h = harness({ usage: envelope({}, 429, { "Retry-After": ["3600"] }) });
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  const result = await h.get();
  assert.deepEqual(result, { signIn: "kept", windows: signalWindows });
  for (let i = 0; i < 11; i++) { h.advance(300_000); assert.deepEqual(await h.get(), result); }
  assert.equal(h.inner().length, 1);
});

test("cached reset cards that have since expired are dropped at display time", async () => {
  const h = harness({ usage: envelope({ ...windows(), cedar_ember: cedar([
    grant({ ends_at: "2026-11-03T20:10:00Z" }), grant({ id: "later" }),
  ]) }) });
  h.files = () => [{ ...row, quota: signals(h.now()) }];
  assert.equal((await h.get()).resets.count, 2);
  h.advance(600_000);
  assert.deepEqual((await h.get()).resets, { count: 1, until: "2026-11-30T00:00:00.000Z",
    each: [{ until: "2026-11-30T00:00:00.000Z", window: "weekly" }] });
  assert.equal(h.inner().length, 1);
});
