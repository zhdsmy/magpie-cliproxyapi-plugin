import assert from "node:assert/strict";
import test from "node:test";
import plugin, { _internal } from "../index.mjs";

const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const usageURL = "https://api.anthropic.com/api/oauth/usage";
const profileURL = "https://api.anthropic.com/api/oauth/profile";
const start = Date.parse("2026-11-03T20:00:00Z");
const row = (auth_index, label = auth_index) => ({ provider: "claude", disabled: false, auth_index, name: auth_index, label });
const envelope = (body, status_code = 200, header) => ({
  status_code,
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...(header ? { header } : {}),
});
const usage = (extra = {}) => ({
  five_hour: { utilization: 5, resets_at: "2026-11-04T00:00:00Z" },
  seven_day: { utilization: 4, resets_at: "2026-11-10T00:00:00Z" },
  ...extra,
});
const limits = (...scoped) => ({ limits: [
  { kind: "session", group: "session", percent: 5, resets_at: "2026-11-04T00:00:00Z", scope: null },
  { kind: "weekly_all", group: "weekly", percent: 4, resets_at: "2026-11-10T00:00:00Z", scope: null },
  ...scoped.map(([name, percent, resets_at = "2026-11-10T00:00:00Z", id = null]) => ({
    kind: "weekly_scoped", group: "weekly", percent, resets_at,
    scope: { model: { id, display_name: name }, surface: null },
  })),
] });
// A fictional profile carrying the personal fields the plugin must drop.
const profile = (organization_type, rate_limit_tier, extra = {}) => ({
  account: { uuid: "uuid-PRIVATE", full_name: "Private Person", display_name: "Private", email: "private@example.invalid",
    has_claude_max: organization_type === "claude_max", has_claude_pro: organization_type === "claude_pro" },
  organization: { uuid: "org-PRIVATE", name: "Private Org", organization_type, rate_limit_tier,
    billing_type: "example_billing", subscription_status: null, claude_code_trial_ends_at: null, ...extra },
  application: { uuid: "app", name: "Claude Code", slug: "claude-code" },
});
const signals = at => ({ observed_at: new Date(at).toISOString(), signals: {
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
  "Anthropic-Ratelimit-Unified-5h-Reset": String(Date.parse("2026-11-04T01:00:00Z") / 1000),
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.17",
  "Anthropic-Ratelimit-Unified-7d-Reset": String(Date.parse("2026-11-10T00:00:00Z") / 1000),
} });

// usages / profiles: per auth_index envelopes (or one for every credential).
function harness({ files = [row("one")], usages = {}, profiles = {}, plainUsages, credentialModels, onRequest } = {}) {
  let clock = start;
  const h = { files, usages, plainUsages, profiles, credentialModels, calls: [],
    advance: ms => { clock += ms; }, now: () => clock };
  const pick = (table, index, fallback) => typeof table === "function" ? table(index)
    : table?.[index] ?? table?.["*"] ?? fallback;
  h.read = _internal.createUsage({ now: () => clock, request: async (url, init) => {
    if (onRequest) {
      const override = await onRequest(url, init, h);
      if (override) return override;
    }
    if (url.endsWith("/credentials")) return Response.json({ files: typeof h.files === "function" ? h.files() : h.files });
    if (url.includes("/credentials/models?")) {
      const name = new URL(url).searchParams.get("name");
      return Response.json({ models: (h.credentialModels?.[name] ?? []).map(id => ({ id })) });
    }
    const body = JSON.parse(init.body);
    h.calls.push(body);
    if (body.url === profileURL) return Response.json(pick(h.profiles, body.auth_index, envelope({}, 404)));
    if (body.url === usageURL && h.plainUsages) return Response.json(pick(h.plainUsages, body.auth_index, envelope(usage())));
    return Response.json(pick(h.usages, body.auth_index, envelope(usage())));
  } });
  h.get = (credential, extra = {}) => h.read(() => ({ type: "api", key: "test-biz-key",
    metadata: { baseURL, managementKey, ...(credential ? { credential } : {}), ...extra } }));
  h.profileReads = () => h.calls.filter(call => call.url === profileURL).length;
  h.usageReads = () => h.calls.filter(call => call.url !== profileURL).length;
  return h;
}

test("the plan comes from the profile's organization type and tier, in Claude's current names", async () => {
  for (const [type, tier, plan] of [["claude_pro", "default_claude_ai", "Pro"],
    ["claude_max", "default_claude_max_5x", "Max"], ["claude_max", "default_claude_max_20x", "Ultra"],
    ["claude_max", undefined, "Max"], ["claude_team", "x", "Team"], ["claude_enterprise", "x", "Enterprise"],
    ["claude_free", "x", undefined], ["", "x", undefined], [undefined, undefined, undefined], [7, "20x", undefined]]) {
    const result = await harness({ profiles: { "*": envelope(profile(type, tier)) } }).get();
    assert.equal(result.plan, plan, String(type) + " " + String(tier));
    assert.equal(result.windows[0].name, "5 hours");
    for (const secret of ["PRIVATE", "Private", "private@", "example_billing", "claude_", "default_"]) {
      assert.ok(!JSON.stringify(result).includes(secret), secret);
    }
  }
});

test("the profile is read once a day; a refusal waits a day, other failures keep the plan and retry in 30 minutes", async () => {
  const h = harness({ profiles: { "*": envelope(profile("claude_max", "default_claude_max_5x")) } });
  assert.equal((await h.get()).plan, "Max");
  h.advance(300_001);
  assert.equal((await h.get()).plan, "Max");
  assert.equal(h.profileReads(), 1, "fresh profile is reused");

  h.profiles = { "*": envelope({ type: "error" }, 429) };
  h.advance(86_400_000);
  assert.equal((await h.get()).plan, "Max", "a 429 keeps the last plan");
  assert.equal(h.profileReads(), 2);
  h.advance(300_001);
  await h.get();
  assert.equal(h.profileReads(), 2, "no retry before 30 minutes");
  h.advance(1_800_000);
  h.profiles = { "*": envelope(profile("claude_pro", "default_claude_ai")) };
  assert.equal((await h.get()).plan, "Pro");
  assert.equal(h.profileReads(), 3);

  for (const status of [401, 403, 404]) {
    const refused = harness({ profiles: { "*": envelope({}, status) } });
    const result = await refused.get();
    assert.equal(result.plan, undefined);
    assert.equal(result.windows.length, 2, "usage is unaffected");
    refused.advance(3_600_000);
    await refused.get();
    assert.equal(refused.profileReads(), 1, "status " + status + " is not asked again within a day");
    refused.advance(86_400_000);
    await refused.get();
    assert.equal(refused.profileReads(), 2);
  }
  for (const bad of [envelope("not json"), { status_code: 200, body: 7 }]) {
    const result = await harness({ profiles: { "*": bad } }).get();
    assert.equal(result.plan, undefined);
    assert.equal(result.windows.length, 2);
  }
});

test("a trial end becomes until while it lies ahead", async () => {
  const ahead = await harness({ profiles: { "*": envelope(profile("claude_pro", "x",
    { claude_code_trial_ends_at: "2026-11-20T00:00:00Z" })) } }).get();
  assert.equal(ahead.until, "2026-11-20T00:00:00.000Z");
  const past = await harness({ profiles: { "*": envelope(profile("claude_pro", "x",
    { claude_code_trial_ends_at: "2026-11-01T00:00:00Z" })) } }).get();
  assert.equal(past.until, undefined);
});

test("several credentials tell their plans together: '<plan> x N' when alike, else 'Mixed (N)'", async () => {
  const files = ["a", "b", "c", "d", "e"].map(index => row(index, "L" + index));
  const plans = { a: ["claude_max", "default_claude_max_20x"], b: ["claude_max", "default_claude_max_5x"],
    c: ["claude_pro", "default_claude_ai"], d: ["claude_max", "default_claude_max_5x"], e: ["claude_free", "x"] };
  const profiles = index => envelope(profile(...plans[index]));
  assert.equal((await harness({ files, profiles }).get()).plan, "Mixed (5)");
  assert.equal((await harness({ files: files.slice(0, 3), profiles }).get()).plan, "Mixed (3)");
  assert.equal((await harness({ files: [files[1], files[4]], profiles }).get()).plan, "Mixed (2)");
  assert.equal((await harness({ files: [files[1], files[3]], profiles }).get()).plan, "Max x 2");
  assert.equal((await harness({ files: [files[4], row("f")], profiles: { e: profiles("e") } }).get()).plan, undefined);
  assert.equal((await harness({ files, profiles }).get("c")).plan, "Pro");
});

test("a transient failure on one credential in a pool keeps its cached plan instead of flickering to Mixed", async () => {
  const files = [row("a", "La"), row("b", "Lb")];
  const h = harness({ files, profiles: { "*": envelope(profile("claude_max", "default_claude_max_5x")) } });
  assert.equal((await h.get()).plan, "Max x 2");
  h.usages = { a: envelope(usage()), b: envelope({}, 500) };
  h.advance(300_001);
  const next = await h.get();
  assert.equal(next.plan, "Max x 2");
  assert.ok(next.windows.some(w => w.name === "Claude Lb" && w.aside === true));
});

test("Fable's own week is model-scoped; 'Not in plan' is inferred only on confirmed Pro with no raw Fable entry", async () => {
  const pro = { "*": envelope(profile("claude_pro", "default_claude_ai")) };
  const max = { "*": envelope(profile("claude_max", "default_claude_max_5x")) };

  const withFable = await harness({ usages: { "*": envelope(usage(limits(["Fable", 2]))) }, profiles: max }).get();
  assert.deepEqual(withFable.windows.slice(2), [
    { name: "7 days · Fable", used: 2, span: 604800, model: "fable", resetsAt: "2026-11-10T00:00:00.000Z" }]);

  const versioned = await harness({
    usages: { "*": envelope(usage(limits(["Fable 5.1", 9], ["Fable 5.1", 1], ["<b>", 1], ["Opus", -1]))) },
    profiles: pro,
  }).get();
  assert.deepEqual(versioned.windows.slice(2).map(w => [w.name, w.model, w.used]), [["7 days · Fable 5.1", "fable-5-1", 9]]);

  // Confirmed Pro with session/weekly_all limits and no Fable entry gets a text-only aside window
  // (no used/span/model so Magpie marks it Text: true and excludes it from summary aggregation).
  const proWithout = await harness({ usages: { "*": envelope(usage(limits(["Sonnet", 3]))) }, profiles: pro }).get();
  assert.deepEqual(proWithout.windows.slice(2), [
    { name: "7 days · Sonnet", used: 3, span: 604800, model: "sonnet", resetsAt: "2026-11-10T00:00:00.000Z" },
    { name: "7 days · Fable", display: "Not in plan", aside: true }]);
  const notInPlan = proWithout.windows.at(-1);
  assert.equal(Object.hasOwn(notInPlan, "used"), false);
  assert.equal(Object.hasOwn(notInPlan, "span"), false);
  assert.equal(Object.hasOwn(notInPlan, "model"), false);

  // Non-Pro plans and unknown profiles NEVER infer "Not in plan".
  for (const prof of [max, { "*": envelope(profile("claude_team", "x")) }, { "*": envelope(profile("claude_enterprise", "x")) }, { "*": envelope({}, 403) }]) {
    const result = await harness({ usages: { "*": envelope(usage(limits())) }, profiles: prof }).get();
    assert.equal(result.windows.length, 2, "must not infer Not in plan for non-Pro/unknown");
  }

  // M2 regressions: malformed or variant Fable entries on Pro must NEVER falsely emit "Not in plan".
  for (const badFable of [
    limits(["Fable", null]),
    limits(["Fable", 5, 1794700800]),
    limits(["Fable (Preview)", 5]),
    limits(["Other", 5, "2026-11-10T00:00:00Z", "claude-fable-5"]),
  ]) {
    const result = await harness({ usages: { "*": envelope(usage(badFable)) }, profiles: pro }).get();
    assert.ok(!result.windows.some(w => w.display === "Not in plan"), JSON.stringify(result.windows));
  }
  const prefixed = await harness({ usages: { "*": envelope(usage(limits(["Claude Fable", 3]))) }, profiles: pro }).get();
  assert.deepEqual(prefixed.windows.slice(2).map(w => [w.name, w.model, w.used]), [["7 days · Claude Fable", "claude-fable", 3]]);

  for (const extra of [{}, { limits: null }, { limits: [] }, { limits: [{ unknown: true }] }]) {
    const result = await harness({ usages: { "*": envelope(usage(extra)) }, profiles: pro }).get();
    assert.equal(result.windows.length, 2, JSON.stringify(extra));
  }
});

test("usage credits show only while on, set aside", async () => {
  const on = await harness({ usages: { "*": envelope(usage({ extra_usage: { is_enabled: true, utilization: 12.5 } })) } }).get();
  assert.deepEqual(on.windows.at(-1), { name: "Usage credits", used: 12.5, aside: true });
  for (const extra_usage of [{ is_enabled: false, utilization: 1 }, { is_enabled: true, utilization: null }, { is_enabled: true, utilization: -1 }]) {
    assert.equal((await harness({ usages: { "*": envelope(usage({ extra_usage })) } }).get()).windows.length, 2);
  }
});

test("in a pool a model's own window counts only exclusive matching models when modelRouting is enabled, else aside", async () => {
  const files = [row("a", "La"), row("b", "Lb")];
  const usages = { a: envelope(usage(limits(["Fable", 2]))), b: envelope(usage(limits())) };
  const profiles = { a: envelope(profile("claude_max", "default_claude_max_5x")), b: envelope(profile("claude_pro", "default_claude_ai")) };

  const aside = await harness({ files, usages, profiles }).get();
  assert.deepEqual(aside.windows.filter(w => w.name.startsWith("7 days · Fable")), [
    { name: "7 days · Fable (Claude La)", used: 2, span: 604800, model: "fable", resetsAt: "2026-11-10T00:00:00.000Z", aside: true },
    { name: "7 days · Fable (Claude Lb)", display: "Not in plan", aside: true },
  ]);

  // With modelRouting enabled, La's Fable window gets only La's exclusive Fable model, while
  // Lb's text-only "Not in plan" window stays aside without models/used/span/model even if Lb lists a Fable ID.
  const usagesCredits = {
    a: envelope(usage({ ...limits(["Fable", 2]), extra_usage: { is_enabled: true, utilization: 10 } })),
    b: envelope(usage(limits())),
  };
  const routed = await harness({
    files, usages: usagesCredits, profiles,
    credentialModels: { a: ["claude-fable-5", "claude-sonnet-4-6"], b: ["claude-fable-5-1", "claude-sonnet-4-6", "claude-haiku-5-5"] },
  }).get("", { modelRouting: "enabled" });
  const fableA = routed.windows.find(w => w.name === "7 days · Fable (Claude La)");
  assert.deepEqual(fableA.models, ["claude-fable-5"]);
  assert.equal(fableA.aside, undefined);
  const fableB = routed.windows.find(w => w.name === "7 days · Fable (Claude Lb)");
  assert.deepEqual(fableB, { name: "7 days · Fable (Claude Lb)", display: "Not in plan", aside: true });
  assert.equal(Object.hasOwn(fableB, "models"), false);
  assert.equal(Object.hasOwn(fableB, "used"), false);
  const creditsA = routed.windows.find(w => w.name === "Usage credits (Claude La)");
  assert.equal(creditsA.aside, true);
  assert.equal(creditsA.models, undefined);
});

test("M1 regression: in plain mode (cedar_ember 403), extra windows still refresh every 30 minutes and expired ones drop", async () => {
  const fableReset = new Date(start + 15 * 60_000).toISOString();
  const h = harness({
    files: () => [{ ...row("one"), quota: signals(h.now()) }],
    usages: { "*": envelope({}, 403) }, // cedar_ember=1 refused -> plain mode
    plainUsages: { "*": envelope(usage(limits(["Fable", 2, fableReset]))) },
    profiles: { "*": envelope(profile("claude_max", "default_claude_max_5x")) },
  });
  const first = await h.get();
  assert.equal(first.windows.find(w => w.model === "fable").used, 2);
  const readsAfterFirst = h.usageReads();

  // After 10 min (< 30m, before fableReset): passive signals suffice, Fable stays at 2%.
  h.advance(10 * 60_000);
  const mid = await h.get();
  assert.equal(h.usageReads(), readsAfterFirst);
  assert.deepEqual(mid.windows.map(w => [w.name, w.used]), [["5 hours", 42], ["7 days", 17], ["7 days · Fable", 2]]);

  // After 20 min total (past fableReset, still < 30m): expired Fable extraWindow is dropped from passive view.
  h.advance(10 * 60_000);
  const expired = await h.get();
  assert.equal(h.usageReads(), readsAfterFirst);
  assert.deepEqual(expired.windows.map(w => w.name), ["5 hours", "7 days"]);

  // After 30 min total: active plain read runs even with fresh passive signals and picks up Fable 95%.
  const nextReset = new Date(start + 7 * 86_400_000).toISOString();
  h.plainUsages = { "*": envelope(usage(limits(["Fable", 95, nextReset]))) };
  h.advance(10 * 60_000);
  const refreshed = await h.get();
  assert.equal(h.usageReads(), readsAfterFirst + 1);
  assert.equal(refreshed.windows.find(w => w.model === "fable").used, 95);
});

test("management 401/403 during profile read trips the breaker; profile timeout leaves usage intact; concurrent selections read profile once", async () => {
  // 1) Management 401 on profile read fails permanently and blocks further reads.
  let blockedCalls = 0;
  const h401 = harness({
    onRequest: async (url, init) => {
      blockedCalls++;
      if (init.body && JSON.parse(init.body).url === profileURL) return new Response("denied", { status: 401 });
    },
  });
  const denied = await h401.get();
  assert.match(denied.error, /management access rejected/);
  assert.equal(denied.windows, undefined);
  const afterDenied = blockedCalls;
  await h401.get();
  assert.equal(blockedCalls, afterDenied, "circuit breaker stops subsequent reads");

  // 2) Profile timeout/network error leaves usage windows intact.
  const hTimeout = harness({
    onRequest: async (_url, init) => {
      if (init.body && JSON.parse(init.body).url === profileURL) throw new Error("timeout");
    },
  });
  const ok = await hTimeout.get();
  assert.equal(ok.error, undefined);
  assert.equal(ok.windows.length, 2);
  assert.equal(ok.plan, undefined);

  // 3) Concurrent selections for the same credential share one profile read.
  let release;
  const gate = new Promise(r => { release = r; });
  const hConcurrent = harness({
    profiles: { "*": envelope(profile("claude_max", "default_claude_max_5x")) },
    onRequest: async (_url, init) => {
      if (init.body && JSON.parse(init.body).url === profileURL) await gate;
    },
  });
  const pending = Promise.all([hConcurrent.get(), hConcurrent.get("one")]);
  await new Promise(r => setTimeout(r, 10));
  release();
  const [r1, r2] = await pending;
  assert.equal(r1.plan, "Max");
  assert.equal(r2.plan, "Max");
  assert.equal(hConcurrent.profileReads(), 1);
});

test("profile 429 honours Retry-After (capped at a day); transient profile failures never force 30m polling on passive-only plain credentials", async () => {
  // 1) Retry-After longer than 30m is respected, and absurdly long values are capped at 24h.
  const ra = harness({ profiles: { "*": envelope({}, 429, { "Retry-After": ["7200"] }) } });
  await ra.get();
  assert.equal(ra.profileReads(), 1);
  ra.advance(1_800_000);
  await ra.get();
  assert.equal(ra.profileReads(), 1, "must wait for 2h Retry-After instead of 30m");
  ra.advance(5_400_000);
  ra.profiles = { "*": envelope(profile("claude_max", "default_claude_max_5x")) };
  assert.equal((await ra.get()).plan, "Max");
  assert.equal(ra.profileReads(), 2);

  const capped = harness({ profiles: { "*": envelope({}, 429, { "Retry-After": ["99999999"] }) } });
  await capped.get();
  capped.advance(86_400_000 - 300_000);
  await capped.get();
  assert.equal(capped.profileReads(), 1, "still waiting before 24h cap");
  capped.advance(300_000);
  capped.profiles = { "*": envelope(profile("claude_pro", "default_claude_ai")) };
  assert.equal((await capped.get()).plan, "Pro");
  assert.equal(capped.profileReads(), 2, "Retry-After capped at 24h");

  // 2) Plain mode + no extraWindows + fresh passive signals:
  //    - 0 active reads for 24h
  //    - 1 active read when daily profileDue fires at 24h
  //    - If that profile read fails transiently (429/500), passive signals do NOT trigger 30m usage+profile loops
  //    - Next day (24h later) triggers 1 active read and recovers
  const freshSignals = at => ({ observed_at: new Date(at).toISOString(), signals: {
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
    "Anthropic-Ratelimit-Unified-5h-Reset": String((at + 5 * 3_600_000) / 1000),
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.17",
    "Anthropic-Ratelimit-Unified-7d-Reset": String((at + 7 * 86_400_000) / 1000),
  } });
  const h = harness({
    files: () => [{ ...row("one"), quota: freshSignals(h.now()) }],
    usages: { "*": envelope({}, 403) },
    plainUsages: { "*": envelope(usage()) },
    profiles: { "*": envelope(profile("claude_max", "default_claude_max_5x")) },
  });
  assert.equal((await h.get()).plan, "Max");
  const initialUsage = h.usageReads();
  assert.equal(h.profileReads(), 1);

  h.advance(86_400_000 - 300_000);
  assert.equal((await h.get()).plan, "Max");
  assert.equal(h.usageReads(), initialUsage, "no active read before 24h");
  assert.equal(h.profileReads(), 1);

  // At 24h, profileDue (and plainUntil's 24h probe) triggers one active refresh; make profile return 429.
  h.profiles = { "*": envelope({}, 429) };
  h.advance(300_000);
  assert.equal((await h.get()).plan, "Max", "keeps last plan on 429");
  assert.equal(h.usageReads(), initialUsage + 2, "daily profileDue wakes plain passive credential once (re-probes cedar_ember + plain)");
  assert.equal(h.profileReads(), 2);

  // Stay on fresh passive signals for 6 hours (12 x 30m): no extra usage/profile polling loop.
  for (let i = 0; i < 12; i++) {
    h.advance(1_800_000);
    assert.equal((await h.get()).plan, "Max");
  }
  assert.equal(h.usageReads(), initialUsage + 2, "transient profile failure must not force 30m usage reads");
  assert.equal(h.profileReads(), 2);

  // Next day (remaining 18h), daily schedule wakes once and picks up the updated plan.
  h.profiles = { "*": envelope(profile("claude_max", "default_claude_max_20x")) };
  h.advance(18 * 3_600_000);
  assert.equal((await h.get()).plan, "Ultra");
  assert.equal(h.usageReads(), initialUsage + 4);
  assert.equal(h.profileReads(), 3);

  // 3) If passive signals go stale after 30m following a transient profile failure, the natural active read retries profile.
  h.profiles = { "*": envelope({}, 503) };
  h.advance(86_400_000);
  assert.equal((await h.get()).plan, "Ultra");
  assert.equal(h.profileReads(), 4);
  h.files = [row("one")]; // passive signals gone
  h.profiles = { "*": envelope(profile("claude_pro", "default_claude_ai")) };
  h.advance(1_800_000);
  assert.equal((await h.get()).plan, "Pro");
  assert.equal(h.profileReads(), 5);
});

test("passive signals preserve the text-only 'Not in plan' window and refresh every 30 minutes even in plain mode", async () => {
  const freshSignals = at => ({ observed_at: new Date(at).toISOString(), signals: {
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
    "Anthropic-Ratelimit-Unified-5h-Reset": String((at + 5 * 3_600_000) / 1000),
    "Anthropic-Ratelimit-Unified-7d-Utilization": "0.17",
    "Anthropic-Ratelimit-Unified-7d-Reset": String((at + 7 * 86_400_000) / 1000),
  } });
  const auth = { type: "api", key: "test-biz-key", metadata: { baseURL, managementKey } };
  const h = harness({
    files: () => [{ ...row("one"), quota: freshSignals(h.now()) }],
    usages: { "*": envelope({}, 403) }, // plain mode
    plainUsages: { "*": envelope(usage(limits())) },
    profiles: { "*": envelope(profile("claude_pro", "default_claude_ai")) },
  });
  const first = await h.get();
  assert.equal(first.plan, "Pro");
  assert.deepEqual(first.windows.at(-1), { name: "7 days · Fable", display: "Not in plan", aside: true });
  assert.equal(await h.read.fableExcluded(auth), true);
  const readsAfterFirst = h.usageReads();

  // At 10 min (< 30m): passive signals keep the text-only window and confirmed exclusion without active reads.
  h.advance(10 * 60_000);
  const mid = await h.get();
  assert.equal(h.usageReads(), readsAfterFirst);
  assert.deepEqual(mid.windows, [
    { name: "5 hours", used: 42, span: 18000, resetsAt: new Date(h.now() + 5 * 3_600_000).toISOString() },
    { name: "7 days", used: 17, span: 604800, resetsAt: new Date(h.now() + 7 * 86_400_000).toISOString() },
    { name: "7 days · Fable", display: "Not in plan", aside: true },
  ]);
  assert.equal(await h.read.fableExcluded(auth), true);

  // At 30 min: active plain refresh runs; a transient 429 falls back to passive display but fails open on exclusion.
  h.plainUsages = { "*": envelope({}, 429) };
  h.advance(20 * 60_000);
  const failedRefresh = await h.get();
  assert.equal(h.usageReads(), readsAfterFirst + 1);
  assert.deepEqual(failedRefresh.windows.at(-1), { name: "7 days · Fable", display: "Not in plan", aside: true });
  assert.equal(await h.read.fableExcluded(auth), false, "read failure must fail open on Fable exclusion");

  // Once backoff ends and account gains Fable, text-only window becomes a real percentage window and exclusion lifts.
  const nextReset = new Date(h.now() + 7 * 86_400_000).toISOString();
  h.plainUsages = { "*": envelope(usage(limits(["Fable", 12, nextReset]))) };
  h.advance(300_000);
  const gained = await h.get();
  assert.deepEqual(gained.windows.at(-1), {
    name: "7 days · Fable", used: 12, span: 604800, model: "fable", resetsAt: nextReset,
  });
  assert.equal(await h.read.fableExcluded(auth), false);
});

function mockDiscoveryFetch(t, {
  modelIDs = ["claude-sonnet-4-6", "claude-fable-5", "claude-fable-5-20261101[1m]", "claude-fable-5-dd-cloaked"],
  files = [row("one")],
  usages = { "*": envelope(usage(limits())) },
  profiles = { "*": envelope(profile("claude_pro", "default_claude_ai")) },
  onFetch,
} = {}) {
  const calls = [];
  const pick = (table, index, fallback) => typeof table === "function" ? table(index)
    : table?.[index] ?? table?.["*"] ?? fallback;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    if (onFetch) {
      const override = await onFetch(url, init, body, calls);
      if (override !== undefined) return override;
    }
    if (url.endsWith("/v1/models")) {
      const anthropic = new Headers(init?.headers).has("anthropic-version");
      return Response.json({ data: modelIDs.map(id => ({ id, ...(anthropic ? { display_name: "Name " + id } : {}) })) });
    }
    if (url.includes("/routing/model-definitions/")) return Response.json({ models: [] });
    if (url.endsWith("/credentials")) return Response.json({ files: typeof files === "function" ? files() : files });
    if (url.endsWith("/requests/api-call")) {
      if (body.url === profileURL) return Response.json(pick(profiles, body.auth_index, envelope({}, 404)));
      return Response.json(pick(usages, body.auth_index, envelope(usage())));
    }
    throw new Error("Unexpected fetch: " + url);
  });
  return { calls };
}

test("provider.models removes Fable models only for confirmed Pro without Fable and shares cache/single-flight with auth.usage", async t => {
  const auth = (extra = {}) => ({ type: "api", key: "test-biz-key",
    metadata: { baseURL, managementKey, ...extra } });

  // 1) Confirmed Pro without Fable omits all Fable models; subsequent auth.usage hits warm cache with 0 extra calls.
  {
    const { calls } = mockDiscoveryFetch(t, {
      files: [row("pro"), { ...row("disabled-max"), disabled: true }],
    });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
    const mgmtAfterModels = calls.filter(c => c.url.includes("/v8/management/")).length;
    const quota = await instance.auth.usage(() => auth());
    assert.equal(calls.filter(c => c.url.includes("/v8/management/")).length, mgmtAfterModels, "auth.usage must reuse cache warmed by models()");
    assert.equal(quota.plan, "Pro");
    const notInPlan = quota.windows.find(w => w.name === "7 days · Fable");
    assert.deepEqual(notInPlan, { name: "7 days · Fable", display: "Not in plan", aside: true });
    assert.equal(Object.hasOwn(notInPlan, "used"), false);
  }

  // 2) Warm usage cache (auth.usage first -> provider.models second) removes Fable with 0 extra management calls.
  {
    const { calls } = mockDiscoveryFetch(t, { files: [row("pro")] });
    const instance = await plugin();
    const quota = await instance.auth.usage(() => auth());
    assert.equal(quota.plan, "Pro");
    const usageCalls = calls.filter(c => c.url.endsWith("/credentials") || c.url.endsWith("/requests/api-call")).length;
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
    assert.equal(calls.filter(c => c.url.endsWith("/credentials") || c.url.endsWith("/requests/api-call")).length, usageCalls,
      "models() must reuse warm usage cache without extra management calls");
  }

  // 3) Explicit credential matching the sole enabled Pro credential also removes Fable.
  {
    mockDiscoveryFetch(t, { files: [row("pro")] });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth({ credential: "pro" }) });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
  }

  // 3) Pool where EVERY enabled credential is confirmed Pro without Fable omits Fable.
  {
    mockDiscoveryFetch(t, { files: [row("pro-a"), row("pro-b")] });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
  }

  // 4) Max (5x / Ultra 20x) and Pro WITH Fable keep all Fable models.
  for (const [label, usages, profiles] of [
    ["Max without Fable limit", { "*": envelope(usage(limits())) }, { "*": envelope(profile("claude_max", "default_claude_max_5x")) }],
    ["Max with Fable limit", { "*": envelope(usage(limits(["Fable", 3]))) }, { "*": envelope(profile("claude_max", "default_claude_max_5x")) }],
    ["Ultra 20x", { "*": envelope(usage(limits(["Fable", 1]))) }, { "*": envelope(profile("claude_max", "default_claude_max_20x")) }],
    ["Pro with Fable limit", { "*": envelope(usage(limits(["Fable", 5]))) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
  ]) {
    mockDiscoveryFetch(t, { usages, profiles });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6", "claude-fable-5", "claude-fable-5-20261101[1m]"], label);
  }

  // 5) Concurrent provider.models and auth.usage share a single in-flight read.
  {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { calls } = mockDiscoveryFetch(t, {
      onFetch: async (url, _init, body) => {
        if (url.endsWith("/requests/api-call") && body.url.includes("/oauth/usage")) await gate;
      },
    });
    const instance = await plugin();
    const modelsPromise = instance.provider.models({}, { auth: auth() });
    const usagePromise = instance.auth.usage(() => auth());
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    const [models, quota] = await Promise.all([modelsPromise, usagePromise]);
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
    assert.equal(quota.plan, "Pro");
    assert.equal(calls.filter(c => c.url.endsWith("/credentials")).length, 1);
    assert.equal(calls.filter(c => c.url.endsWith("/requests/api-call")).length, 2, "one usage + one profile shared");
  }

  // 6) No Fable model in /v1/models skips usage/profile reads entirely.
  {
    const { calls } = mockDiscoveryFetch(t, { modelIDs: ["claude-sonnet-4-6", "claude-fable-5-dd-cloaked"] });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), ["claude-sonnet-4-6"]);
    assert.equal(calls.filter(c => c.url.endsWith("/credentials") || c.url.endsWith("/requests/api-call")).length, 0);
  }
});

test("provider.models fails open (keeps Fable models) on every unconfirmed, mixed, error or timeout case", async t => {
  const allExpected = ["claude-sonnet-4-6", "claude-fable-5", "claude-fable-5-20261101[1m]"];
  const auth = (extra = {}) => ({ type: "api", key: "test-biz-key",
    metadata: { baseURL, managementKey, ...extra } });

  // 1) Missing managementKey keeps Fable and sends zero management requests.
  {
    const { calls } = mockDiscoveryFetch(t);
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: { type: "api", key: "test-biz-key", metadata: { baseURL } } });
    assert.deepEqual(Object.keys(models), allExpected);
    assert.equal(calls.filter(c => c.url.includes("/v8/management/")).length, 0);
  }

  // 2) Unknown plan / profile refused / missing limits / malformed Fable entry on Pro -> fail-open.
  const unconfirmedCases = [
    ["profile 403", { "*": envelope(usage(limits())) }, { "*": envelope({}, 403) }],
    ["profile 429", { "*": envelope(usage(limits())) }, { "*": envelope({}, 429) }],
    ["unknown org type", { "*": envelope(usage(limits())) }, { "*": envelope(profile("claude_free", "x")) }],
    ["missing limits", { "*": envelope(usage()) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
    ["empty limits", { "*": envelope(usage({ limits: [] })) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
    ["malformed Fable limit", { "*": envelope(usage(limits(["Fable", null]))) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
    ["Fable by model.id only", { "*": envelope(usage(limits(["Other", 5, "2026-11-10T00:00:00Z", "claude-fable-5"]))) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
    ["upstream usage 500", { "*": envelope({}, 500) }, { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
  ];
  for (const [label, usages, profiles] of unconfirmedCases) {
    mockDiscoveryFetch(t, { usages, profiles });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), allExpected, label);
  }

  // 3) Mixed credentials, partial failure, unsupported sibling, and explicit selection in a multi-credential CPA -> fail-open.
  const mixedCases = [
    ["pool Pro + Max", [row("pro"), row("max")], "",
      { pro: envelope(usage(limits())), max: envelope(usage(limits(["Fable", 2]))) },
      { pro: envelope(profile("claude_pro", "default_claude_ai")), max: envelope(profile("claude_max", "default_claude_max_5x")) }],
    ["pool Pro + Codex", [row("pro"), { provider: "codex", disabled: false, auth_index: "cx", name: "cx" }], "",
      { pro: envelope(usage(limits())), cx: envelope({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: start / 1000 + 3600 } } }) },
      { pro: envelope(profile("claude_pro", "default_claude_ai")) }],
    ["pool Pro + unsupported", [row("pro"), { provider: "gemini", disabled: false, auth_index: "gm", name: "gm" }], "",
      { pro: envelope(usage(limits())) }, { pro: envelope(profile("claude_pro", "default_claude_ai")) }],
    ["pool Pro + failing Pro", [row("pro1"), row("pro2")], "",
      { pro1: envelope(usage(limits())), pro2: envelope({}, 500) },
      { "*": envelope(profile("claude_pro", "default_claude_ai")) }],
    ["explicit Pro inside mixed pool", [row("pro"), row("max")], "pro",
      { pro: envelope(usage(limits())), max: envelope(usage(limits(["Fable", 2]))) },
      { pro: envelope(profile("claude_pro", "default_claude_ai")), max: envelope(profile("claude_max", "default_claude_max_5x")) }],
  ];
  for (const [label, files, credential, usages, profiles] of mixedCases) {
    mockDiscoveryFetch(t, { files, usages, profiles });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth(credential ? { credential } : {}) });
    assert.deepEqual(Object.keys(models), allExpected, label);
  }

  // 4) Management 401/403 during discovery fails open on Fable and trips the shared breaker.
  {
    const { calls } = mockDiscoveryFetch(t, {
      onFetch: async url => {
        if (url.includes("/v8/management/")) return new Response("denied", { status: 401 });
      },
    });
    const instance = await plugin();
    const models = await instance.provider.models({}, { auth: auth() });
    assert.deepEqual(Object.keys(models), allExpected);
    assert.equal(calls.filter(c => c.url.endsWith("/credentials")).length, 0, "breaker already tripped by definitions");
    const quota = await instance.auth.usage(() => auth());
    assert.match(quota.error, /management access rejected/);
  }

  // 5) Slow usage/profile check times out at the models() wait cap and fails open without failing discovery.
  {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutArgs = [];
    t.mock.method(AbortSignal, "timeout", ms => {
      timeoutArgs.push(ms);
      return realTimeout(ms === 5_000 ? 25 : ms);
    });
    let release;
    let apiCalled = false;
    const gate = new Promise(resolve => { release = resolve; });
    mockDiscoveryFetch(t, {
      onFetch: async url => {
        if (url.endsWith("/requests/api-call")) { apiCalled = true; await gate; }
      },
    });
    const instance = await plugin();
    const alive = setTimeout(() => {}, 1000);
    try {
      const models = await instance.provider.models({}, { auth: auth() });
      assert.deepEqual(Object.keys(models), allExpected, "timed-out usage check must fail open");
      assert.equal(apiCalled, true, "usage check must actually run before timing out");
      assert.ok(timeoutArgs.includes(5_000), "models() must cap Fable wait at 5000ms");
      // Once the shared in-flight read completes in the background, the next models() sees the warm cache.
      release();
      await new Promise(resolve => setTimeout(resolve, 25));
      const next = await instance.provider.models({}, { auth: auth() });
      assert.deepEqual(Object.keys(next), ["claude-sonnet-4-6"]);
    } finally {
      release();
      clearTimeout(alive);
    }
  }

  // 6) Aborted caller signal during Fable check fails open instead of failing discovery.
  {
    const controller = new AbortController();
    let release;
    let apiCalled = false;
    const gate = new Promise(resolve => { release = resolve; });
    mockDiscoveryFetch(t, {
      onFetch: async url => {
        if (url.endsWith("/requests/api-call")) {
          apiCalled = true;
          controller.abort(new DOMException("cancelled", "AbortError"));
          await gate;
        }
      },
    });
    const instance = await plugin();
    try {
      const models = await instance.provider.models({}, { auth: auth(), signal: controller.signal });
      assert.deepEqual(Object.keys(models), allExpected);
      assert.equal(apiCalled, true);
    } finally {
      release();
    }
  }
});
