import assert from "node:assert/strict";
import test from "node:test";
import plugin, { _internal } from "../index.mjs";

const start = Date.parse("2026-11-14T08:00:00Z");
const iso = ms => new Date(ms).toISOString();
const auth = { type: "api", key: "fictional-business", metadata: {
  baseURL: "https://cpa.example.invalid", managementKey: "fictional-management",
} };
const file = (name, provider = "codex") => ({ name, provider, auth_index: name + "-index", disabled: false });
const usage = { plan_type: "plus", rate_limit: { primary_window: {
  used_percent: 25, limit_window_seconds: 18000, reset_at: start / 1000 + 86400,
} } };
const credit = (id = "first", expires_at = iso(start + 86400000)) => ({
  id, status: "available", reset_type: "codex_rate_limits", expires_at,
});
const inventory = () => ({ available_count: 2, credits: [credit("later", iso(start + 172800000)), credit()] });
const signals = at => ({ observed_at: iso(at), signals: {
  "x-codex-primary-used-percent": "40", "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(start / 1000 + 86400),
  "x-codex-secondary-used-percent": "50", "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(start / 1000 + 604800),
} });

function harness(files = [file("one")]) {
  let clock = start;
  const h = { files, payload: structuredClone(usage), inventory: inventory(), models: {}, calls: [],
    inventoryStatus: 200, modelStatus: {}, advance: ms => { clock += ms; }, now: () => clock };
  const read = _internal.createUsage({ now: () => clock, request: async (url, init) => {
    const path = new URL(url).pathname;
    assert.ok(!/config|api-key|download|consume|reset_rate_limits/.test(url));
    h.calls.push({ url, init });
    if (path.endsWith("/credentials")) return Response.json({ files: h.files });
    if (path.endsWith("/credentials/models")) {
      assert.equal(init.method, "GET");
      const name = new URL(url).searchParams.get("name");
      if (h.modelGate) await h.modelGate();
      return Response.json(h.models[name] ?? { models: [] }, { status: h.modelStatus[name] ?? 200 });
    }
    assert.ok(path.endsWith("/requests/api-call"));
    const body = JSON.parse(init.body);
    assert.equal(body.method, "GET");
    assert.ok(!/consume|reset_rate_limits/.test(body.url));
    const resets = body.url.endsWith("/rate-limit-reset-credits");
    assert.ok(resets || body.url.endsWith("/wham/usage") || body.url.includes("anthropic.com/api/oauth/usage"));
    if (resets && h.inventoryFailure) throw new TypeError("private transport details");
    if (resets && h.inventoryManagementStatus) return new Response("private", { status: h.inventoryManagementStatus });
    if (body.url.endsWith("/wham/usage") && h.usageStatus) return Response.json({ status_code: h.usageStatus, body: "{}" });
    const data = body.url.includes("anthropic.com") ? { five_hour: { utilization: 25, resets_at: iso(start + 86400000) } }
      : resets ? h.inventory : h.payload;
    return Response.json({ status_code: resets ? h.inventoryStatus : 200, body: JSON.stringify(data) });
  } });
  h.get = (routing = true, credential) => read(() => ({ ...auth,
    metadata: { ...auth.metadata, ...(routing ? { modelRouting: "enabled" } : {}), ...(credential ? { credential } : {}) } }));
  h.inner = suffix => h.calls.filter(c => c.init.body && JSON.parse(c.init.body).url.endsWith(suffix));
  h.memberships = () => h.calls.filter(c => new URL(c.url).pathname.endsWith("/credentials/models"));
  return h;
}

test("Codex selects Responses and only its channel definitions, preserving IDs and API options", async t => {
  const rows = [
    { id: "gpt-test-20261114[1m]", owned_by: "openai" }, { id: "alias", owned_by: "openai" },
    { id: "claude-test", owned_by: "openai" }, { id: "compat", owned_by: "custom" }, { id: "unknown" },
  ];
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    paths.push(url);
    if (url.includes("model-definitions/")) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fictional-management");
      return Response.json({ models: [{ id: "gpt-test", thinking: { levels: [" low ", "xhigh", "low"] } },
        { id: "alias", thinking: { levels: ["high"] } }, { id: "compat", thinking: { levels: ["max"] } }] });
    }
    return Response.json({ data: rows });
  });
  const hooks = await plugin();
  const configured = { api: { id: "wrong-alias", url: "https://override.example.invalid", npm: "@ai-sdk/anthropic" } };
  const models = await hooks.provider.models({ models: { [rows[0].id]: configured,
    alias: { variants: { custom: {} }, capabilities: { reasoning: false } } } }, { auth });
  assert.deepEqual(models[rows[0].id].api, { url: configured.api.url, npm: "@ai-sdk/openai" });
  assert.deepEqual(models[rows[0].id].variants, { low: {}, xhigh: {} });
  assert.equal(models[rows[0].id].id, rows[0].id);
  assert.equal(configured.api.id, "wrong-alias");
  assert.deepEqual(models.alias.variants, { custom: {} });
  assert.equal(models.alias.capabilities.reasoning, false);
  for (const id of ["claude-test", "compat", "unknown"]) assert.equal(models[id].api, undefined);
  assert.equal(paths.length, 4);
  assert.deepEqual(paths.map(url => new URL(url).pathname).sort(), [
    "/v1/models", "/v1/models", "/v8/management/routing/model-definitions/claude", "/v8/management/routing/model-definitions/codex",
  ]);
  const bare = await hooks.provider.models({}, { auth: { ...auth, metadata: { baseURL: auth.metadata.baseURL } } });
  assert.equal(bare.alias.api.npm, "@ai-sdk/openai");
  assert.equal(bare.alias.variants, undefined);
});

test("Claude and Codex definitions run in parallel and fail independently", async t => {
  for (const failing of ["claude", "codex"]) {
    let releases = [];
    const mocked = t.mock.method(globalThis, "fetch", async url => {
      if (url.includes("model-definitions/")) {
        await new Promise(resolve => { releases.push(resolve); });
        return url.endsWith(failing) ? new Response("bad", { status: 500 }) : Response.json({ models: [
          { id: "gpt-test", thinking: { levels: ["xhigh"] } }, { id: "claude-test", thinking: { levels: ["max"] } },
        ] });
      }
      return Response.json({ data: [{ id: "gpt-test", owned_by: "openai" }, { id: "claude-test", owned_by: "anthropic" }] });
    });
    const pending = (await plugin()).provider.models({}, { auth });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases.forEach(resolve => resolve());
    const models = await pending;
    assert.equal(models[failing === "claude" ? "gpt-test" : "claude-test"].capabilities.reasoning, true);
    assert.equal(models[failing === "claude" ? "claude-test" : "gpt-test"].variants, undefined);
    mocked.mock.restore();
  }
});

test("Codex reset cards use GET-only inventory, correct headers and sorted Magpie shape", async () => {
  const h = harness([{ ...file("one"), id_token: { chatgpt_account_id: "fictional-account" } }]);
  const result = await h.get();
  assert.deepEqual(result.resets, { count: 2, byWindow: false, until: iso(start + 86400000),
    each: [{ until: iso(start + 86400000) }, { until: iso(start + 172800000) }] });
  const request = JSON.parse(h.inner("/rate-limit-reset-credits")[0].init.body);
  assert.equal(request.header["Chatgpt-Account-Id"], "fictional-account");
  assert.equal(request.header["OpenAI-Beta"], "codex-1");
  assert.equal(request.header.Originator, "Codex Desktop");
  assert.equal(request.header.Accept, "application/json");
  assert.ok(!JSON.stringify(result).includes("fictional-account"));
  assert.ok(result.resets.each.every(card => !Object.hasOwn(card, "window")));
});

test("Codex usage inventory wins and avoids a details request; mismatched counts omit each", async () => {
  const h = harness();
  h.payload.rate_limit_reset_credits = inventory();
  assert.equal((await h.get()).resets.count, 2);
  assert.equal(h.inner("/rate-limit-reset-credits").length, 0);
  const mismatch = harness();
  mismatch.inventory.available_count = 3;
  assert.deepEqual((await mismatch.get()).resets, { count: 3, byWindow: false, until: iso(start + 86400000) });
});

test("Codex inventory failures and malformed blocks keep windows and back off per credential", async () => {
  for (const status of [400, 403, 404, 429, 500]) {
    const h = harness();
    h.inventoryStatus = status;
    assert.equal((await h.get()).resets, undefined);
    for (let i = 1; i < 6; i++) {
      h.advance(300000);
      assert.equal((await h.get()).windows[0].used, 25);
    }
    assert.equal(h.inner("/rate-limit-reset-credits").length, 1);
    h.advance(300000);
    h.inventoryStatus = 200;
    assert.equal((await h.get()).resets.count, 2);
    assert.equal(h.inner("/rate-limit-reset-credits").length, 2);
  }
  for (const block of [null, {}, { available_count: -1 }, { available_count: "2" },
    { available_count: 1.5 }, { ...inventory(), credits: [credit(), credit()] }]) {
    const h = harness();
    h.inventory = block;
    assert.equal((await h.get()).resets, undefined);
    assert.equal((await h.get()).windows.length, 1);
  }
});

test("fresh Codex signals read only inventory, once every 30 minutes, with shared memo", async () => {
  const h = harness();
  for (let i = 0; i <= 6; i++) {
    h.files[0].quota = signals(h.now());
    const result = await h.get();
    assert.equal(result.windows[0].used, 40);
    assert.equal(result.resets.count, 2);
    if (i < 6) h.advance(300000);
  }
  assert.equal(h.inner("/wham/usage").length, 0);
  assert.equal(h.inner("/rate-limit-reset-credits").length, 2);
  await h.get(true, "one");
  await h.get(true, "one-index");
  assert.equal(h.inner("/rate-limit-reset-credits").length, 2);
});

test("Codex cached cards expire and multi-credential views omit resets", async () => {
  const h = harness();
  h.inventory = { available_count: 1, credits: [credit("short", iso(start + 300000))] };
  assert.equal((await h.get()).resets.count, 1);
  h.advance(300000);
  assert.equal((await h.get()).resets, undefined);
  const pool = harness([file("one"), file("two")]);
  assert.equal((await pool.get()).resets, undefined);
  assert.equal((await pool.get(true, "one")).resets.count, 2);
});

test("Codex null inventory and transport failures do not create repeated detail reads", async () => {
  const h = harness();
  h.payload.rate_limit_reset_credits = null;
  h.inventoryFailure = true;
  assert.equal((await h.get()).windows.length, 1);
  h.advance(300000);
  await h.get();
  assert.equal(h.inner("/rate-limit-reset-credits").length, 1);
  assert.equal((await h.get()).resets, undefined);
  for (const status of [401, 403]) {
    const denied = harness();
    denied.inventoryManagementStatus = status;
    assert.match((await denied.get()).error, /management access rejected/);
    const count = denied.calls.length;
    denied.advance(3600000);
    await denied.get();
    assert.equal(denied.calls.length, count);
  }
});

test("an inventory-only refresh retains the known Codex plan", async () => {
  const h = harness();
  assert.equal((await h.get()).plan, "plus");
  h.advance(1800000);
  h.files[0].quota = signals(h.now());
  assert.equal((await h.get()).plan, "plus");
  assert.equal(h.inner("/wham/usage").length, 1);
  assert.equal(h.inner("/rate-limit-reset-credits").length, 2);
});

test("a stalled optional inventory times out before the shared budget and keeps valid windows", async () => {
  let inventorySignal;
  const read = _internal.createUsage({ now: () => start,
    timeout: ms => AbortSignal.timeout(ms === 3000 ? 5 : ms),
    request: async (url, init) => {
      if (url.endsWith("/credentials")) return Response.json({ files: [file("one")] });
      const template = JSON.parse(init.body);
      if (template.url.endsWith("/rate-limit-reset-credits")) {
        inventorySignal = init.signal;
        return new Promise(() => {});
      }
      return Response.json({ status_code: 200, body: JSON.stringify(usage) });
    } });
  // Keep the event loop alive even though AbortSignal.timeout's own timer is unref'd.
  const alive = setTimeout(() => {}, 1000);
  try {
    const result = await read(() => auth);
    assert.equal(result.windows[0].used, 25);
    assert.equal(result.resets, undefined);
    assert.equal(inventorySignal.aborted, true);
  } finally { clearTimeout(alive); }
});

test("a late usage response skips optional inventory to preserve its valid windows", async () => {
  let now = start, details = 0;
  const read = _internal.createUsage({ now: () => now, request: async (url, init) => {
    if (url.endsWith("/credentials")) return Response.json({ files: [file("one")] });
    if (JSON.parse(init.body).url.endsWith("/rate-limit-reset-credits")) details++;
    now += 14500;
    return Response.json({ status_code: 200, body: JSON.stringify(usage) });
  } });
  assert.equal((await read(() => auth)).windows[0].used, 25);
  assert.equal(details, 0);
});

test("model routing opt-in defaults off and authorize only persists an explicit enable", async () => {
  const method = (await plugin()).auth.methods[0];
  const prompt = method.prompts.find(p => p.key === "modelRouting");
  assert.equal(prompt.type, "select");
  assert.equal(prompt.options[0].value, "disabled");
  assert.match(prompt.message, /config API keys, openai-compatibility or plugins/);
  for (const modelRouting of [undefined, "disabled", "true", true]) {
    assert.equal((await method.authorize({ baseURL: auth.metadata.baseURL, businessKey: auth.key, modelRouting })).metadata.modelRouting, undefined);
  }
  assert.equal((await method.authorize({ baseURL: auth.metadata.baseURL, businessKey: auth.key, modelRouting: "enabled" })).metadata.modelRouting, "enabled");
  const h = harness([file("one"), file("two")]);
  assert.ok((await h.get(false)).windows.every(w => w.aside));
  assert.equal(h.memberships().length, 0);
});

test("model routing includes only exclusive IDs, dedupes membership and shares its 15s cache", async () => {
  const h = harness([file("one", "claude"), file("two")]);
  h.models.one = { models: [{ id: "claude-only" }, { id: "shared" }, { id: "SHARED" }] };
  h.models.two = { models: [{ id: "gpt-only" }, { id: "shared" }, { id: "gpt-only" }] };
  const [first, second] = await Promise.all([h.get(), h.get()]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.windows.map(w => w.models), [["claude-only"], ["gpt-only"]]);
  assert.ok(first.windows.every(w => !Object.hasOwn(w, "aside")));
  assert.equal(h.memberships().length, 2);
  await h.get(false); // shared upstream readings do not acquire routing metadata
  assert.equal(h.memberships().length, 2);
  h.advance(300000);
  await h.get();
  assert.equal(h.memberships().length, 4);
});

test("unknown or failed model membership leaves the entire pool aside; explicit selection skips it", async () => {
  for (const failure of [500, "malformed", "empty", "shared", "unsupported"]) {
    const h = harness([file("one"), file("two", failure === "unsupported" ? "other" : "codex")]);
    h.models.one = { models: [{ id: "gpt-only" }] };
    h.models.two = failure === "malformed" ? { models: [{}] }
      : { models: failure === "shared" ? [{ id: "GPT-ONLY" }] : [] };
    if (failure === 500) h.modelStatus.two = 500;
    const result = await h.get();
    if (failure === "empty") assert.deepEqual(result.windows[0].models, ["gpt-only"]);
    else assert.ok(result.windows.every(w => w.aside && !w.models));
    const before = h.memberships().length;
    assert.ok((await h.get(true, "one")).windows.every(w => w.aside));
    assert.equal(h.memberships().length, before);
  }
  const single = harness();
  assert.equal((await single.get()).windows[0].aside, undefined);
  assert.equal(single.memberships().length, 0);
});

test("model membership management rejection stops the scope; concurrency stays at two", async () => {
  const h = harness(Array.from({ length: 5 }, (_, i) => file(String(i))));
  let running = 0, peak = 0;
  h.modelGate = async () => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
  };
  await h.get();
  assert.equal(peak, 2);
  for (const status of [401, 403]) {
    const denied = harness([file("one"), file("two"), file("three")]);
    denied.modelStatus.one = status;
    assert.match((await denied.get()).error, /management access rejected/);
    const before = denied.calls.length;
    denied.advance(3600000);
    await denied.get(false, "two");
    assert.equal(denied.calls.length, before);
  }
});

test("model membership accepts credential ID, encodes names and leaves failed usage rows aside", async () => {
  const h = harness([{ ...file("one"), name: undefined, id: "file/id" }, file("two & private")]);
  h.models["file/id"] = { models: [{ id: "one-only" }] };
  h.models["two & private"] = { models: [{ id: "two-only" }] };
  assert.deepEqual((await h.get()).windows.map(w => w.models), [["one-only"], ["two-only"]]);
  assert.ok(h.memberships().some(c => c.url.endsWith("name=two%20%26%20private")));
  h.advance(300000);
  h.files[1].provider = "claude";
  h.usageStatus = 500;
  const result = await h.get();
  assert.ok(result.windows.find(w => w.name === "Codex one-inde").aside);
  assert.deepEqual(result.windows.find(w => w.name.includes("5 hours")).models, ["two-only"]);
});
