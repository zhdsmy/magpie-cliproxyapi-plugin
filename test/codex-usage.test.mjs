import assert from "node:assert/strict";
import test from "node:test";
import { _internal } from "../index.mjs";

const now = Date.parse("2026-11-14T08:00:00Z");
const codex = { provider: "codex", disabled: false, auth_index: "0123456789abcdef",
  name: "private@example.invalid.json", id_token: { chatgpt_account_id: "fictional-workspace" } };
const claude = { provider: "claude", disabled: false, auth_index: "fedcba9876543210", label: "Alpha" };
const window = (used_percent = 25, limit_window_seconds = 18000) => ({ used_percent,
  limit_window_seconds, reset_at: now / 1000 + 3600 });
const data = () => ({ plan_type: "plus", rate_limit: { primary_window: window(), secondary_window: window(50, 604800) } });
const claudeData = () => ({ five_hour: { utilization: 25, resets_at: new Date(now + 3600000).toISOString() },
  seven_day: { utilization: 50, resets_at: new Date(now + 604800000).toISOString() },
  cedar_ember: { eligible: true, grants: [{ id: "fictional", type: "session", resets_left: 1 }] } });
const response = (body, status_code = 200) => Response.json({ status_code, body: JSON.stringify(body) });

function harness(files = [codex], payload = data(), request, timeout) {
  let clock = now;
  const calls = [];
  const read = _internal.createUsage({ now: () => clock, ...(timeout ? { timeout } : {}), request: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/credentials")) return Response.json({ files });
    const body = JSON.parse(init.body);
    if (request) return request(body, init);
    return response(body.url.includes("anthropic.com") ? claudeData() : payload);
  } });
  return { calls, advance: ms => { clock += ms; }, get: (credential) => read(() => ({ type: "api", key: "fictional-business",
    metadata: { baseURL: "https://cpa.example.invalid", managementKey: "fictional-management", ...(credential ? { credential } : {}) } })) };
}

function signals(overrides = {}) {
  return { observed_at: new Date(now).toISOString(), signals: {
    "X-Codex-Primary-Used-Percent": "12.5", "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-At": String(now / 1000 + 3600),
    "X-Codex-Secondary-Used-Percent": "65", "X-Codex-Secondary-Window-Minutes": "10080",
    "X-Codex-Secondary-Reset-After-Seconds": "7200", "X-Codex-Plan-Type": "plus", ...overrides,
  } };
}

test("Codex uses wham via shared api-call, the management-center UA and optional workspace header", async () => {
  for (const id_token of [codex.id_token, undefined, {}, { chatgpt_account_id: "" }, { chatgpt_account_id: "bad\r\nheader" }]) {
    const h = harness([{ ...codex, id_token }]);
    const result = await h.get();
    assert.deepEqual(result, { windows: [
      { name: "5 hours", used: 25, span: 18000, resetsAt: new Date(now + 3600000).toISOString() },
      { name: "7 days", used: 50, span: 604800, resetsAt: new Date(now + 3600000).toISOString() },
    ], plan: "plus", signIn: "kept" });
    const body = JSON.parse(h.calls[1].init.body);
    assert.deepEqual(body, { auth_index: codex.auth_index, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
        "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
        ...(id_token === codex.id_token ? { "Chatgpt-Account-Id": "fictional-workspace" } : {}) } });
    assert.equal(h.calls[0].init.signal, h.calls[1].init.signal);
    assert.equal(h.calls[1].init.redirect, "error");
    assert.ok(!JSON.stringify(result).includes("fictional-workspace"));
    assert.equal((await h.get(codex.auth_index)).plan, "plus");
    assert.equal(h.calls.length, 2, "selections share the upstream cache");
  }
});

test("Codex duration names cover monthly, non-hour and singular windows; only known plans survive", async () => {
  for (const [span, name] of [[2592000, "30 days"], [5400, "90 minutes"], [3600, "1 hour"], [61, "61 seconds"]]) {
    const result = await harness([codex], { plan_type: "free", rate_limit: { primary_window: window(0, span) } }).get();
    assert.equal(result.windows[0].name, name);
    assert.equal(result.plan, "free");
  }
  for (const plan_type of ["unknown", "private@example.invalid", {}, "PLUS", "plus\n"]) {
    assert.equal((await harness([codex], { ...data(), plan_type }).get()).plan, undefined);
  }
});

test("Codex skips malformed windows and errors when none is valid", async () => {
  const malformed = [null, {}, { ...window(), used_percent: "1" }, { ...window(), used_percent: -1 },
    { ...window(), used_percent: 101 }, { ...window(), used_percent: Infinity },
    { ...window(), limit_window_seconds: 0 }, { ...window(), limit_window_seconds: 1.5 },
    { ...window(), limit_window_seconds: "18000" }, { ...window(), reset_at: "1794646800" },
    { ...window(), reset_at: -1 }, { ...window(), reset_at: 8.64e12 + 1 }];
  for (const row of malformed) {
    const result = await harness([codex], { rate_limit: { primary_window: row, secondary_window: window(50) } }).get();
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].used, 50);
    const failed = await harness([codex], { rate_limit: { primary_window: row } }).get();
    assert.match(failed.error, /no valid Codex quota windows/);
    assert.equal(failed.windows, undefined);
    assert.equal(failed.signIn, "kept");
  }
  assert.ok((await harness([codex], { additional_rate_limits: [{ rate_limit: data().rate_limit }] }).get()).error);
});

test("fresh complete Codex signals avoid wham, preserve plan and anchor relative resets to observation time", async () => {
  const h = harness([{ ...codex, quota: signals() }]);
  const result = await h.get();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result.windows.map(w => [w.name, w.used, w.span]), [["5 hours", 12.5, 18000], ["7 days", 65, 604800]]);
  assert.equal(result.plan, "plus");
  h.advance(300000);
  const later = await h.get();
  assert.equal(later.windows[1].resetsAt, new Date(now + 7200000).toISOString());
  assert.equal(h.calls.length, 2, "the five-minute boundary remains fresh");
});

test("old, future, partial, expired and malformed Codex signals fall back to wham", async () => {
  const bad = [undefined, { ...signals(), observed_at: "bad" }, { ...signals(), observed_at: new Date(now - 300001).toISOString() },
    { ...signals(), observed_at: new Date(now + 60001).toISOString() },
    signals({ "X-Codex-Secondary-Used-Percent": undefined }), signals({ "X-Codex-Primary-Used-Percent": "101" }),
    signals({ "X-Codex-Primary-Window-Minutes": "0" }), signals({ "X-Codex-Primary-Reset-At": String(now / 1000) }),
    signals({ "X-Codex-Primary-Used-Percent": "1e2" }), signals({ "X-Codex-Primary-Reset-At": "9999999999999" })];
  for (const quota of bad) {
    const h = harness([{ ...codex, quota }]);
    const result = await h.get();
    assert.equal(result.windows[0].used, 25);
    assert.equal(h.calls.length, 2);
  }
});

test("pure Claude, pure Codex and mixed pools display all supported credentials in stable order", async () => {
  const otherCodex = { ...codex, auth_index: "1123456789abcdef", label: "Zulu" };
  const otherClaude = { ...claude, auth_index: "eedcba9876543210", label: "Beta" };
  for (const files of [[otherClaude, claude], [otherCodex, codex], [otherCodex, claude, codex, otherClaude]]) {
    const first = await harness(files).get();
    const reordered = await harness([...files].reverse()).get();
    assert.deepEqual(first, reordered);
    assert.equal(first.windows.length, files.length * 2);
    assert.ok(first.windows.every(w => w.aside === true));
    assert.equal(first.plan, undefined);
    assert.equal(first.resets, undefined);
    assert.ok(!JSON.stringify(first).includes("@"));
    assert.ok(first.windows[0].name.startsWith("5 hours ("));
  }
  const mixed = await harness([codex, claude]).get();
  assert.deepEqual(mixed.windows.map(w => w.name), ["5 hours (Claude Alpha)", "7 days (Claude Alpha)",
    "5 hours (Codex 01234567)", "7 days (Codex 01234567)"]);
  const selected = await harness([codex, claude]).get(claude.auth_index);
  assert.equal(selected.windows.length, 2);
  assert.ok(selected.windows.every(w => w.aside));
  assert.equal(selected.resets.count, 1);
  assert.equal((await harness([claude]).get()).resets.count, 1);
});

test("names and email-like labels are never displayed; fallback labels remain stable under reorder", async () => {
  const h = harness([{ ...codex, label: "private@example.invalid" }, { ...claude, label: "\nunsafe" }]);
  const result = await h.get();
  assert.ok(!JSON.stringify(result).includes("@"));
  assert.ok(result.windows.some(w => w.name.endsWith("(Codex 01234567)")));
  const selected = await h.get(codex.name);
  assert.ok(selected.windows.every(w => w.name.endsWith("(Codex 01234567)")));
});

test("a failed credential is a text aside row; all failed credentials return an error", async () => {
  const request = body => response({}, body.auth_index === codex.auth_index ? 401 : 200);
  const h = harness([codex, claude], data(), body => body.auth_index === codex.auth_index ? request(body) : response(claudeData()));
  const result = await h.get();
  assert.equal(result.error, undefined);
  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows[2], { name: "Codex 01234567", display: "Quota unavailable; check credential in CPA", aside: true });
  assert.ok(result.windows.every(w => w.aside));
  const all = await harness([codex, claude], data(), () => response({}, 500)).get();
  assert.ok(all.error);
  assert.equal(all.windows, undefined);
});

test("credential reads use the scope limit of two and share the 15-second signal", async () => {
  let running = 0, peak = 0;
  const pending = [];
  const files = Array.from({ length: 5 }, (_, i) => ({ ...codex, auth_index: String(i).padStart(16, "0") }));
  const h = harness(files, data(), () => new Promise(resolve => {
    running++; peak = Math.max(peak, running);
    pending.push(() => { running--; resolve(response(data())); });
  }));
  const reading = h.get();
  const turn = () => new Promise(resolve => setImmediate(resolve));
  await turn();
  assert.equal(pending.length, 2);
  while (pending.length) {
    pending.shift()();
    await turn();
  }
  assert.equal((await reading).windows.length, 10);
  assert.equal(peak, 2);
  assert.equal(h.calls.length, 6);
  assert.ok(h.calls.every(call => call.init.signal === h.calls[0].init.signal));
});

test("multi-credential management 401/403 stop queued reads and later selections", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const files = Array.from({ length: 5 }, (_, i) => ({ ...codex, auth_index: String(i).padStart(16, "0") }));
    const h = harness(files, data(), () => { calls++; return new Response("private", { status }); });
    const result = await h.get();
    assert.match(result.error, /management access rejected/);
    assert.equal(result.windows, undefined);
    assert.ok(calls <= 2);
    h.advance(3600000);
    await h.get(files[4].auth_index);
    assert.ok(calls <= 2);
  }
});

test("all credential reads stop at the common budget even if a transport ignores abort", async () => {
  const controller = new AbortController();
  const files = Array.from({ length: 5 }, (_, i) => ({ ...codex, auth_index: String(i).padStart(16, "0") }));
  let budget;
  const h = harness(files, data(), () => new Promise(() => {}), ms => { budget = ms; return controller.signal; });
  const pending = h.get();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("budget expired"));
  const result = await pending;
  assert.ok(result.error);
  assert.equal(result.windows, undefined);
  assert.equal(budget, 15000);
  assert.equal(h.calls.length, 3);
});

test("the two-read limit also covers different selections refreshed together", async () => {
  let running = 0, peak = 0;
  const pending = [];
  const files = Array.from({ length: 4 }, (_, i) => ({ ...codex, auth_index: String(i).padStart(16, "0") }));
  const h = harness(files, data(), () => new Promise(resolve => {
    running++; peak = Math.max(peak, running);
    pending.push(() => { running--; resolve(response(data())); });
  }));
  const results = Promise.all(files.map(file => h.get(file.auth_index)));
  const turn = () => new Promise(resolve => setImmediate(resolve));
  await turn();
  assert.equal(pending.length, 2);
  while (pending.length) { pending.shift()(); await turn(); }
  assert.ok((await results).every(result => result.windows.length === 2));
  assert.equal(peak, 2);
  assert.equal(h.calls.length, 5, "all selections share one credential list");
});

test("management rejection cannot fall back to Claude passive windows or return a partial pool", async () => {
  const quota = { observed_at: new Date(now).toISOString(), signals: {
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 3600),
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": String(now / 1000 + 604800),
  } };
  const h = harness([{ ...claude, quota }, codex], data(), () => new Response("private", { status: 403 }));
  const result = await h.get();
  assert.match(result.error, /management access rejected/);
  assert.equal(result.windows, undefined);
});


test("an explicit Claude selection in a multi-credential CPA keeps resets while its windows stay aside", async () => {
  for (const files of [[claude, codex], [claude, { ...claude, auth_index: "1123456789abcdef" }]]) {
    const result = await harness(files).get(claude.auth_index);
    assert.deepEqual(result.resets, { count: 1, each: [{ window: "fiveHour" }] });
    assert.ok(result.windows.every(window => window.aside === true));
    assert.equal((await harness(files).get()).resets, undefined);
  }
  for (const quota of [undefined, signals()]) {
    const h = harness([claude, { ...codex, quota }]);
    const result = await h.get(codex.auth_index);
    assert.equal(result.plan, "plus");
    assert.ok(result.windows.every(window => window.aside === true));
    assert.equal((await h.get()).plan, undefined);
  }
});

test("active Codex windows use relative reset seconds or omit unknown resets without dropping quota", async () => {
  const base = { used_percent: 25, limit_window_seconds: 18000 };
  for (const [resetFields, expected] of [
    [{ reset_after_seconds: 3600 }, new Date(now + 3600000).toISOString()],
    [{ reset_at: null, reset_after_seconds: 0 }, new Date(now).toISOString()],
    [{}, undefined], [{ reset_at: null, reset_after_seconds: null }, undefined],
    [{ reset_at: now / 1000 + 7200, reset_after_seconds: 3600 }, new Date(now + 7200000).toISOString()],
  ]) {
    const result = await harness([codex], { rate_limit: { primary_window: { ...base, ...resetFields } } }).get();
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].used, 25);
    assert.equal(result.windows[0].span, 18000);
    assert.equal(result.windows[0].resetsAt, expected);
    assert.equal(Object.hasOwn(result.windows[0], "resetsAt"), expected !== undefined);
  }
  for (const reset_after_seconds of [-1, "3600", 8.64e12]) {
    const result = await harness([codex], { rate_limit: { primary_window: { ...base, reset_after_seconds } } }).get();
    assert.ok(result.error);
  }
});
