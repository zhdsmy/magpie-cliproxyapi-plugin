import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import plugin, { _internal } from "../index.mjs";

const managementKey = "test-mgmt-key-LEAKCHECK";
const businessKey = "test-biz-key-usage";
const baseURL = "https://cpa.example.invalid";
const reset = "2026-11-04T00:00:00Z";
const row = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
const second = { ...row, auth_index: "index-two", name: "two", label: "Second" };
const window = (utilization = 25, resets_at = reset) => ({ utilization, resets_at });
const data = () => ({ five_hour: window(), seven_day: window(50) });
const envelope = (body = data(), status_code = 200) => ({ status_code, body: JSON.stringify(body) });
const account = (metadata = {}) => ({ type: "api", key: businessKey,
  metadata: { baseURL, managementKey, ...metadata } });

function harness({ files = [row], usage = envelope(), request, timeout, adapters } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const h = { files, usage, calls, advance: ms => { clock += ms; } };
  h.read = _internal.createUsage({ now: () => clock, ...(timeout ? { timeout } : {}), ...(adapters ? { adapters } : {}),
    request: async (url, init) => {
      calls.push({ url, init });
      if (request) return request(url, init, h);
      return Response.json(url.endsWith("/credentials") ? { files: h.files } : h.usage);
    },
  });
  h.get = (metadata = {}) => h.read(() => account(metadata));
  return h;
}

function assertError(result) {
  assert.equal(result.signIn, "kept");
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
  assert.equal(result.windows, undefined);
  for (const secret of [managementKey, businessKey, "private-response-marker"]) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
}

test("usage hook is registered; absent management key makes no request", async () => {
  assert.equal(typeof (await plugin()).auth.usage, "function");
  const h = harness();
  assert.deepEqual(await h.read(() => undefined), {});
  assert.deepEqual(await h.get({ managementKey: "" }), {});
  assert.equal(h.calls.length, 0);
});

test("single enabled credential uses the exact api-call template and percentage windows", async () => {
  const h = harness({ files: [null, { ...row, provider: "other", disabled: true }, { ...row, disabled: true }, row] });
  const result = await h.get();
  assert.deepEqual(result, { signIn: "kept", windows: [
    { name: "5 hours", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" },
    { name: "7 days", used: 50, span: 604800, resetsAt: "2026-11-04T00:00:00.000Z" },
  ] });
  assert.equal(h.calls.length, 2);
  const [credentials, api] = h.calls;
  assert.equal(credentials.url, baseURL + "/v8/management/credentials");
  assert.equal(credentials.init.method, "GET");
  assert.equal(api.url, baseURL + "/v8/management/requests/api-call");
  assert.equal(api.init.method, "POST");
  assert.deepEqual(JSON.parse(api.init.body), {
    auth_index: "index-one", method: "GET", url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
    header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.280 (external, cli)", Accept: "application/json" },
  });
  assert.equal(credentials.init.signal, api.init.signal);
  for (const { init } of h.calls) {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + managementKey);
    assert.ok(!(init.body ?? "").includes(managementKey));
    assert.ok(!JSON.stringify(init).includes(businessKey));
  }
});

test("credential selection rejects zero, multiple unselected, missing, disabled and ambiguous matches", async () => {
  for (const [files, selection] of [[[], ""], [[row, second], ""], [[row], "missing"],
    [[row, { ...second, disabled: true }], "two"], [[row, { ...second, name: "one" }], "one"],
    [[{ ...row, disabled: undefined }], ""], [[{ ...row, disabled: 0 }], ""]]) {
    const h = harness({ files });
    assertError(await h.get({ credential: selection }));
    assert.equal(h.calls.length, 1);
  }
});

test("selected multi-credential windows are display-only and use label/name, never email", async () => {
  for (const credential of ["two", "index-two"]) {
    const h = harness({ files: [row, { ...second, email: "private-response-marker" }] });
    const result = await h.get({ credential });
    assert.equal(JSON.parse(h.calls[1].init.body).auth_index, "index-two");
    assert.ok(result.windows.every(w => w.aside === true && w.name.endsWith("(credential Second)")));
    assert.ok(!JSON.stringify(result).includes("private-response-marker"));
  }
  const h = harness({ files: [row, { ...second, label: undefined }] });
  assert.match((await h.get({ credential: "two" })).windows[0].name, /credential two/);
  const single = harness();
  assert.equal((await single.get({ credential: "one" })).windows[0].aside, undefined);
});

test("auth_index must be a nonempty string of at most 128 characters", async () => {
  for (const auth_index of [undefined, null, 1, "", " ", "x".repeat(129)]) {
    const h = harness({ files: [{ ...row, auth_index }] });
    assertError(await h.get());
    assert.equal(h.calls.length, 1);
  }
  const h = harness({ files: [{ ...row, auth_index: "x".repeat(128) }] });
  assert.equal((await h.get()).windows.length, 2);
});

test("management 401/403 including IP-ban 403 stop all automatic retries", async () => {
  for (const status of [401, 403]) {
    const h = harness({ request: () => new Response("remote management disabled or IP banned; private-response-marker", { status }) });
    for (let i = 0; i < 10; i++) {
      assertError(await h.get());
      h.advance(1_800_000);
    }
    assert.equal(h.calls.length, 1);
    assertError(await h.get({ credential: "another" }));
    assert.equal(h.calls.length, 1, "changing selection must not retry a rejected management key");
    assertError(await h.get({ managementKey: "test-mgmt-key-replacement" }));
    assert.equal(h.calls.length, 2);
  }
});

test("management auth failure at api-call also stops future credential requests", async () => {
  const h = harness({ request: url => url.endsWith("/credentials") ? Response.json({ files: [row] })
    : new Response("private-response-marker", { status: 403 }) });
  assertError(await h.get());
  h.advance(2_000_000);
  assertError(await h.get());
  assert.equal(h.calls.length, 2);
});

test("management rejection drops cached quota even if response cancellation fails", async () => {
  let rejected = false;
  const h = harness({ request: url => {
    if (rejected) return { status: 401, body: { cancel() { throw new Error("private-response-marker"); } } };
    return Response.json(url.endsWith("/credentials") ? { files: [row] } : envelope());
  } });
  assert.equal((await h.get()).windows[0].used, 25);
  rejected = true;
  h.advance(300_000);
  assertError(await h.get());
  assertError(await h.get());
  assert.equal(h.calls.length, 3);
});

test("temporary management/network errors back off 300 seconds without leaking exception text", async () => {
  for (const failure of [500, 429, "network"]) {
    const h = harness({ request: () => {
      if (failure === "network") throw new Error(managementKey + " private-response-marker");
      return new Response("private-response-marker", { status: failure });
    } });
    assertError(await h.get());
    h.advance(299_999);
    assertError(await h.get());
    assert.equal(h.calls.length, 1);
    h.advance(1);
    assertError(await h.get());
    assert.equal(h.calls.length, 2);
  }
});

test("inner non-200 status never creates a valid quota or permanently blocks management", async () => {
  for (const status of [401, 429, 500, 201, "200", undefined]) {
    const h = harness({ usage: { status_code: status, body: JSON.stringify(data()) } });
    assertError(await h.get());
    assert.equal(h.calls.length, 2);
    h.usage = envelope();
    h.advance(300_000);
    assert.equal((await h.get()).windows[0].used, 25);
    assert.equal(h.calls.length, 4);
  }
});

test("invalid JSON and envelopes do not turn unknown quota into zero", async () => {
  for (const body of ["private-response-marker", "null", "{}", '{"files":{}}']) {
    const h = harness({ request: () => new Response(body) });
    assertError(await h.get());
  }
  for (const usage of [{ status_code: 200 }, { status_code: 200, body: {} },
    { status_code: 200, body: "private-response-marker" }, envelope(null), envelope({})]) {
    assertError(await harness({ usage }).get());
  }
});

test("only valid known percentage windows survive; values over 100 are preserved", async () => {
  const h = harness({ usage: envelope({ five_hour: window(125), seven_day: window(0, null),
    seven_day_sonnet: window(99), new_future_window: { anything: true }, limits: [{ unknown: true }] }) });
  assert.deepEqual((await h.get()).windows, [
    { name: "5 hours", used: 125, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" },
    { name: "7 days", used: 0, span: 604800 },
  ]);
  for (const invalid of [null, {}, window(-1), window("0"), window(true), window(null),
    window(1, null), window(0, "not-a-date"), { utilization: 0 }]) {
    const one = await harness({ usage: envelope({ five_hour: invalid, seven_day: window(10) }) }).get();
    assert.equal(one.windows.length, 1);
    assert.equal(one.windows[0].name, "7 days");
    assertError(await harness({ usage: envelope({ five_hour: invalid }) }).get());
  }
  const body = '{"five_hour":{"utilization":1e999,"resets_at":"' + reset + '"}}';
  assertError(await harness({ usage: { status_code: 200, body } }).get());
});

test("oversized credentials and api-call streams are cancelled at their own limits", async () => {
  for (const path of ["/credentials", "/requests/api-call"]) {
    let cancelled = false, pulls = 0;
    const h = harness({ request: url => {
      if (!url.endsWith(path)) return Response.json({ files: [row] });
      return new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(100_000)); },
        cancel() { cancelled = true; },
      }));
    } });
    assertError(await h.get());
    assert.ok(cancelled);
    assert.ok(pulls <= (path === "/credentials" ? 12 : 4));
  }
});

test("five concurrent calls share exactly one credentials plus api-call pair", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness({ request: async url => {
    if (url.endsWith("/credentials")) { started(); await gate; return Response.json({ files: [row] }); }
    return Response.json(envelope());
  } });
  const pending = Array.from({ length: 5 }, () => h.get());
  await ready;
  assert.equal(h.calls.length, 1);
  release();
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.windows[0].used === 25 && result.signIn === "kept"));
  assert.equal(h.calls.length, 2);
});

test("success cache expires at 300s; transient failure preserves at most 900s old readings; repeated failures back off", async () => {
  const h = harness();
  const first = await h.get();
  h.advance(299_999);
  assert.deepEqual(await h.get(), first);
  assert.equal(h.calls.length, 2);
  h.advance(1);
  h.usage = envelope(data(), 500);
  assert.deepEqual(await h.get(), first);
  assert.equal(h.calls.length, 4);
  h.advance(299_999);
  assert.deepEqual(await h.get(), first);
  assert.equal(h.calls.length, 4);
  h.advance(300_001);
  assert.deepEqual(await h.get(), first);
  h.advance(1);
  assertError(await h.get());
  // The second upstream failure doubled the pause to 600s: CPA is asked, Anthropic is not.
  h.usage = envelope({ five_hour: window(5), seven_day: window(10) });
  h.advance(300_000);
  assertError(await h.get());
  assert.equal(h.calls.length, 7);
  assert.ok(h.calls.at(-1).url.endsWith("/credentials"));
  h.advance(300_000);
  assert.equal((await h.get()).windows[0].used, 5);
  assert.equal(h.calls.length, 9);
});

test("inner failure never replaces a cached reading with its plausible body", async () => {
  for (const status of [401, 429, 500]) {
    const h = harness();
    const first = await h.get();
    h.advance(300_000);
    h.usage = envelope({ five_hour: window(99) }, status);
    assert.deepEqual(await h.get(), first);
  }
});

test("a newly ambiguous credential pool invalidates old routing windows", async () => {
  const h = harness();
  await h.get();
  h.advance(300_000);
  h.files = [row, second];
  assertError(await h.get());
});

test("cache is isolated by management key and endpoint; selections naming one credential share it", async () => {
  const h = harness();
  await h.get();
  for (const metadata of [{ managementKey: "test-mgmt-key-other" },
    { managementURL: "https://management.example.invalid/private" }]) {
    await h.get(metadata);
  }
  assert.equal(h.calls.length, 6);
  // "", the name and the auth_index all resolve to index-one: one credential list, one upstream read.
  for (const credential of ["one", "index-one"]) assert.equal((await h.get({ credential })).windows[0].used, 25);
  await h.get();
  assert.equal(h.calls.length, 6);
  h.advance(15_000);
  await h.get({ credential: "other-selection-same-scope" });
  assert.equal(h.calls.length, 7);
  assert.ok(h.calls.at(-1).url.endsWith("/credentials"));
});

test("management credentials stay at the explicit management endpoint, never the OAuth target", async () => {
  const h = harness();
  await h.get({ managementURL: "https://management.example.invalid/custom/" });
  for (const call of h.calls) {
    assert.ok(call.url.startsWith("https://management.example.invalid/custom/"));
    assert.ok(!call.url.startsWith("https://api.anthropic.com/"));
    assert.ok(!call.init.body?.includes(managementKey));
  }
  const bad = harness();
  assertError(await bad.get({ managementURL: "https://user:password@example.invalid/" }));
  assert.equal(bad.calls.length, 0);
});

test("one shared 15s deadline bounds both stages even if the request ignores cancellation", async () => {
  const controller = new AbortController();
  const budgets = [];
  const h = harness({ timeout: ms => {
    budgets.push(ms); return budgets.length === 1 ? controller.signal : new AbortController().signal;
  }, request: (url, init, clock) => {
    assert.equal(init.signal, controller.signal);
    if (url.endsWith("/credentials")) { clock.advance(10_000); return Response.json({ files: [row] }); }
    clock.advance(6_000);
    controller.abort(new DOMException("private-response-marker", "TimeoutError"));
    return new Promise(() => {});
  } });
  assertError(await h.get());
  assert.deepEqual(budgets, [15000]);
  assert.equal(h.calls.length, 2);
  assertError(await h.get());
  assert.equal(h.calls.length, 2);
});

test("single-flight waiters return within the shared request budget", async () => {
  const controllers = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness({ timeout: ms => {
    assert.equal(ms, 15000);
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  }, request: () => { started(); return new Promise(() => {}); } });
  const first = h.get();
  await ready;
  const others = Array.from({ length: 4 }, () => h.get());
  await Promise.resolve(); await Promise.resolve();
  controllers[0].abort(new DOMException("timed out", "TimeoutError"));
  for (const result of await Promise.all([first, ...others])) assertError(result);
  assert.equal(h.calls.length, 1);
});

test("getAuth and other internal exceptions always resolve to kept errors", async () => {
  const h = harness();
  assertError(await h.read(() => { throw new Error(managementKey); }));
  assertError(await h.get({ baseURL: "invalid" }));
  assertError(await h.get({ credential: {} }));
  assertError(await h.get({ managementKey: {} }));
  const brokenClock = _internal.createUsage({ now: () => { throw new Error(managementKey); } });
  assertError(await brokenClock(() => account()));
});

test("real management redirects are rejected without sending the key to their target", async t => {
  let targetRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end("unexpected"); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:" + target.address().port + "/leak" }); res.end();
  });
  source.listen(0, "127.0.0.1"); await once(source, "listening");
  t.after(() => { for (const server of [source, target]) { server.closeAllConnections(); server.close(); } });
  const read = _internal.createUsage();
  assertError(await read(() => account({ managementURL: "http://127.0.0.1:" + source.address().port })));
  assert.equal(targetRequests, 0);
});

test("provider adapter dispatches its own request template and parser through the shared cache", async () => {
  let parsed = 0;
  const template = { method: "GET", url: "https://usage.example.invalid/mock",
    header: { Authorization: "Bearer $TOKEN$", Accept: "application/json" } };
  const adapter = {
    async read(apiCall, credential) {
      assert.equal(credential.auth_index, row.auth_index);
      const body = await apiCall(template);
      parsed++; assert.deepEqual(body, { percent: 17 });
      return { windows: [{ name: "Mock window", used: body.percent, span: 3600 }] };
    },
  };
  const h = harness({ adapters: { mock: adapter }, files: [{ ...row, provider: "mock" }],
    usage: envelope({ percent: 17 }) });
  const result = await h.get();
  assert.deepEqual(result, { signIn: "kept", windows: [{ name: "Mock window", used: 17, span: 3600 }] });
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { ...template, auth_index: row.auth_index });
  assert.equal(new Headers(h.calls[1].init.headers).get("authorization"), "Bearer " + managementKey);
  assert.deepEqual(await h.get(), result);
  assert.equal(parsed, 1);
  assert.equal(h.calls.length, 2);
});

test("unsupported providers never fall back to Claude or call api-call, including inherited object names", async () => {
  for (const provider of ["other", "constructor", "__proto__", undefined]) {
    for (const credential of ["", "two", "index-two"]) {
      const unsupported = { ...second, provider };
      const h = harness({ files: credential ? [row, unsupported] : [unsupported] });
      const result = await h.get({ credential });
      assertError(result);
      assert.equal(result.error, "Quota is not supported for this provider yet");
      assert.equal(h.calls.length, 1);
    }
  }
});

test("automatic selection uses the sole enabled supported credential; a mixed pool stays display-only", async () => {
  const h = harness({ files: [{ ...second, provider: "other" }, row,
    { ...second, auth_index: "disabled", disabled: true }] });
  const result = await h.get();
  assert.equal(JSON.parse(h.calls[1].init.body).auth_index, row.auth_index);
  assert.ok(result.windows.every(w => w.aside === true && w.name.endsWith("(credential First)")));
});

test("several supported providers require an explicit unique selection and share the aside rule", async () => {
  const adapter = { read: async apiCall => {
    await apiCall({ method: "GET", url: "https://usage.example.invalid/mock", header: {} });
    return { windows: [{ name: "Mock window", used: 10, span: 3600 }] };
  } };
  const h = harness({ adapters: { mockA: adapter, mockB: adapter },
    files: [{ ...row, provider: "mockA" }, { ...second, provider: "mockB" }] });
  assertError(await h.get());
  assert.equal(h.calls.length, 1);
  const result = await h.get({ credential: "index-two" });
  assert.equal(JSON.parse(h.calls.at(-1).init.body).auth_index, "index-two");
  assert.deepEqual(result.windows, [{ name: "Mock window (credential Second)", used: 10, span: 3600, aside: true }]);
  assert.equal(result.signIn, "kept");
});

test("unsupported selection replaces old quota with an error instead of reusing routing windows", async () => {
  const h = harness();
  assert.equal((await h.get()).windows[0].used, 25);
  h.advance(300_000);
  h.files = [{ ...row, provider: "other" }];
  assertError(await h.get());
  assert.equal(h.calls.length, 3);
});

test("new adapters retain the common management rejection circuit breaker", async () => {
  const h = harness({ adapters: { mock: { read: async apiCall => {
    await apiCall({ method: "GET", url: "https://usage.example.invalid/mock" });
    throw new Error("must not parse rejected response");
  } } }, files: [{ ...row, provider: "mock" }],
    request: (url, _init, h) => url.endsWith("/credentials") ? Response.json({ files: h.files })
      : new Response("private-response-marker", { status: 403 }) });
  for (let i = 0; i < 10; i++) { assertError(await h.get()); h.advance(1_800_000); }
  assert.equal(h.calls.length, 2);
});
