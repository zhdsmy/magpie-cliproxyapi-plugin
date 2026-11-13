import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import plugin, { _internal } from "../index.mjs";

const bizKey = "test-biz-key-transport";
const managementKey = "test-mgmt-key-LEAKCHECK";
const baseURL = "https://cpa.example.invalid";
const auth = () => ({ type: "api", key: bizKey, metadata: { baseURL, managementKey } });

async function localServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

test("URL validation rejects invalid or credential-bearing addresses", () => {
  for (const value of [undefined, "", "  ", "not-a-url", "/relative", "ftp://example.invalid",
    "file:///tmp/cpa", "https://user:secret@example.invalid", "https://user@example.invalid",
    "https://example.invalid?key=secret", "https://example.invalid?", "https://example.invalid#x",
    "https://example.invalid#"]) {
    assert.throws(() => _internal.normalizeURL(value));
  }
  for (const [value, expected] of [
    [" https://CPA.example.invalid/v1/// ", baseURL],
    ["https://cpa.example.invalid/proxy/v1/", baseURL + "/proxy"],
    ["http://127.0.0.1:8317/", "http://127.0.0.1:8317"],
    ["http://[::1]:8317/v1", "http://[::1]:8317"],
  ]) assert.equal(_internal.normalizeURL(value), expected);
});

test("config registers only cpa and preserves existing configuration", async () => {
  const hooks = await plugin();
  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(cfg.provider, { cpa: { name: "CLIProxyAPI", npm: "@ai-sdk/anthropic", models: {} } });
  const existing = { name: "Existing", models: { kept: {} } };
  const custom = { provider: { cpa: existing, other: {} } };
  await hooks.config(custom);
  assert.equal(custom.provider.cpa, existing);
  assert.deepEqual(custom.provider.other, {});
});

test("authorize is local and returns the business key separately from metadata", async t => {
  const hooks = await plugin();
  assert.equal(hooks.auth.provider, "cpa");
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  assert.deepEqual(method.prompts.map(({ key, type }) => [key, type]), [
    ["baseURL", "text"], ["businessKey", "password"], ["managementKey", "password"], ["managementURL", "text"], ["credential", "text"],
  ]);
  const unexpected = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const result = await method.authorize({
    baseURL: "https://cpa.example.invalid:8317/v1/", businessKey: bizKey,
    managementURL: "https://management.example.invalid/v8/management/",
    managementKey: " " + managementKey + " ", credential: " credential-one ",
  });
  assert.deepEqual(result, { type: "success", key: bizKey, metadata: {
    baseURL: "https://cpa.example.invalid:8317", email: "cpa@cpa.example.invalid:8317",
    managementURL: "https://management.example.invalid/v8/management", managementKey, credential: "credential-one",
  } });
  assert.ok(!JSON.stringify(result.metadata).includes(bizKey));
  assert.deepEqual(await method.authorize({ baseURL, businessKey: bizKey }), { type: "success", key: bizKey, metadata: {
    baseURL, email: "cpa@cpa.example.invalid",
  } });
  assert.deepEqual(await method.authorize({ baseURL, businessKey: bizKey, managementKey: " ", managementURL: " ", credential: " " }),
    await method.authorize({ baseURL, businessKey: bizKey }));
  assert.equal((await method.authorize({ baseURL })).type, "failed");
  assert.equal((await method.authorize({ baseURL, businessKey: bizKey, managementURL: "https://user:secret@example.invalid" })).type, "failed");
  assert.equal((await method.authorize({ baseURL: "not-a-url", businessKey: bizKey })).type, "failed");
  assert.equal(unexpected.mock.callCount(), 0);
});

test("loader keeps request data, caller UA and cancellation signal without adding management credentials", async t => {
  const hooks = await plugin();
  const loader = await hooks.auth.loader(auth);
  assert.equal(loader.baseURL, baseURL + "/v1");
  assert.equal(loader.apiKey, bizKey);
  assert.deepEqual(await hooks.auth.loader(() => undefined), {});
  const response = new Response('{"error":"rate_limited"}', { status: 429 });
  const mocked = t.mock.method(globalThis, "fetch", async () => response);
  const input = new URL(baseURL + "/v1/messages");
  const headers = new Headers({ "x-api-key": bizKey, "user-agent": "test-caller", "content-type": "application/json" });
  const body = JSON.stringify({ model: "claude-test", messages: [] });
  const controller = new AbortController();
  const result = await loader.fetch(input, { method: "POST", headers, body, signal: controller.signal, redirect: "follow" });
  assert.equal(result, response);
  assert.equal(result.status, 429);
  assert.equal(await result.text(), '{"error":"rate_limited"}');
  assert.equal(mocked.mock.callCount(), 1);
  const [receivedInput, init] = mocked.mock.calls[0].arguments;
  assert.equal(receivedInput, input);
  assert.equal(init.headers, headers);
  assert.equal(init.body, body);
  assert.equal(init.signal, controller.signal);
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.get("user-agent"), "test-caller");
  assert.ok(!JSON.stringify([...init.headers]).includes(managementKey));
  assert.ok(!init.body.includes(managementKey));
});

test("real fetch rejects redirects without reaching the destination", async t => {
  let redirected = 0;
  const target = await localServer(t, (_request, response) => { redirected++; response.end("unexpected"); });
  const source = await localServer(t, (_request, response) => {
    response.writeHead(302, { Location: target + "/destination" });
    response.end();
  });
  const loader = await (await plugin()).auth.loader(() => ({ ...auth(), metadata: { baseURL: source, managementKey } }));
  await assert.rejects(loader.fetch(source + "/v1/messages"), TypeError);
  assert.equal(redirected, 0);
});

test("abort signal cancels an in-flight request", async t => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const base = await localServer(t, () => received());
  const loader = await (await plugin()).auth.loader(() => ({ ...auth(), metadata: { baseURL: base } }));
  const controller = new AbortController();
  const pending = loader.fetch(base + "/v1/messages", { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
