import assert from "node:assert/strict";
import test from "node:test";
import plugin, { _internal } from "../index.mjs";

const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const usageURL = "https://api.anthropic.com/api/oauth/usage";
const row = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
const windows = () => ({
  five_hour: { utilization: 25, resets_at: "2026-11-04T00:00:00Z" },
  seven_day: { utilization: 50, resets_at: "2026-11-10T00:00:00Z" },
});
const grant = (extra = {}) => ({ id: "fable-launch", label: "Launch offer", resets_total: 2, resets_left: 2,
  starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-30T00:00:00Z", clears: ["five_hour", "seven_day"],
  paused: false, usable_now: false, use_requires_limit: true, type: "weekly", gives_back_weekly: true, ...extra });
const block = (grants = [grant()], extra = {}) => ({ eligible: true, at_limit: false, grants,
  next_grant_id: grants[0]?.id ?? null, weekly_resets_at: null, cooldown_until: null, ...extra });
const envelope = (body, status_code = 200) => ({ status_code, body: JSON.stringify(body) });

function harness({ usage = envelope({ ...windows(), cedar_ember: block() }), plain } = {}) {
  const clock = Date.parse("2026-11-03T20:00:00Z");
  const calls = [];
  const h = { usage, plain: plain ?? envelope(windows()), calls };
  h.read = _internal.createUsage({ now: () => clock, request: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/credentials")) return Response.json({ files: [row] });
    return Response.json(body.url === usageURL ? h.plain : h.usage);
  } });
  h.get = () => h.read(() => ({ type: "api", key: "test-biz-key", metadata: { baseURL, managementKey } }));
  h.inner = () => calls.filter(call => call.url.endsWith("/requests/api-call")).map(call => call.body);
  return h;
}

test("Claude reset grants come from the same usage read and use Magpie's resets shape", async () => {
  const h = harness({ usage: envelope({ ...windows(), cedar_ember: block([
    grant(),
    grant({ id: "session-bonus", resets_total: 1, resets_left: 1, type: "session", ends_at: "2026-11-20T00:00:00Z" }),
    grant({ id: "forever", resets_total: 1, resets_left: 1, type: "full", ends_at: null }),
  ]) }) });
  const result = await h.get();
  assert.deepEqual(result.windows, [
    { name: "5 hours", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" },
    { name: "7 days", used: 50, span: 604800, resetsAt: "2026-11-10T00:00:00.000Z" },
  ]);
  assert.deepEqual(result.resets, { count: 4, until: "2026-11-20T00:00:00.000Z", each: [
    { until: "2026-11-20T00:00:00.000Z", window: "fiveHour" },
    { until: "2026-11-30T00:00:00.000Z", window: "weekly" },
    { until: "2026-11-30T00:00:00.000Z", window: "weekly" },
    {},
  ] });
  assert.ok(!JSON.stringify(result).includes("fable-launch"), "grant ids stay internal");
  assert.ok(!JSON.stringify(result).includes("Launch offer"));
});

test("only one read-only GET is sent; no claim, profile or cooldown request", async () => {
  const h = harness();
  await h.get();
  assert.deepEqual(h.inner().map(call => [call.method, call.url]), [["GET", usageURL + "?cedar_ember=1"]]);
  assert.equal(h.inner()[0].data, undefined);
  for (const call of h.calls) {
    assert.ok(!/reset_rate_limits|oauth\/profile|cooldown/.test(call.url + JSON.stringify(call.body ?? {})));
  }
});

test("no usable grant inventory leaves resets out but keeps the windows", async () => {
  for (const cedar_ember of [undefined, null, {}, { eligible: "yes" }, block([]),
    block([grant({ resets_left: 0 })]), block([grant({ ends_at: "2026-11-03T19:59:59Z" })]),
    block([grant(), grant()]), block([grant(), grant({ id: "Bad ID" })]), block([grant({ resets_left: 3 })]),
    block([grant({ resets_left: 1.5 })]), block([grant({ ends_at: "soon" })]), block([grant({ starts_at: 1 })]),
    block([grant({ resets_left: 101, resets_total: 101 })]), { eligible: true, grants: {} }]) {
    const result = await harness({ usage: envelope({ ...windows(), cedar_ember }) }).get();
    assert.equal(result.resets, undefined, JSON.stringify(cedar_ember));
    assert.equal(result.windows.length, 2);
  }
});

test("ineligible, paused or not-yet-usable grants are still listed as held", async () => {
  const result = await harness({ usage: envelope({ ...windows(), cedar_ember: block(
    [grant({ paused: true, resets_left: 1, resets_total: undefined })], { eligible: false, ineligible_reason: "tier" }) }) }).get();
  assert.deepEqual(result.resets, { count: 1, until: "2026-11-30T00:00:00.000Z",
    each: [{ until: "2026-11-30T00:00:00.000Z", window: "weekly" }] });
});

test("an upstream 400/403 on the opt-in query falls back once to the plain usage read", async () => {
  for (const status of [400, 403]) {
    const h = harness({ usage: envelope({}, status) });
    const result = await h.get();
    assert.equal(result.windows.length, 2);
    assert.equal(result.resets, undefined);
    assert.deepEqual(h.inner().map(call => call.url), [usageURL + "?cedar_ember=1", usageURL]);
  }
  for (const status of [401, 429, 500]) {
    const h = harness({ usage: envelope({}, status) });
    assert.equal(typeof (await h.get()).error, "string");
    assert.equal(h.inner().length, 1, "no fallback for status " + status);
  }
});

test("magpie host contract: resets survive the plugin hook unchanged", async t => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/credentials")) return Response.json({ files: [row] });
    return Response.json(envelope({ ...windows(), cedar_ember: block() }));
  });
  const usage = await (await plugin()).auth.usage(() => ({ type: "api", key: "k", metadata: { baseURL, managementKey } }));
  assert.equal(usage.resets.count, 2);
  assert.equal(usage.resets.each.length, 2);
});
