import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.mjs";

const auth = { type: "api", key: "test-biz-key-discovery", metadata: {
  baseURL: "https://cpa.example.invalid", managementKey: "test-mgmt-key-LEAKCHECK",
} };
const id = "claude-sonnet-4-5-20250929";
const row = { id, type: "model", display_name: "Claude Sonnet", max_input_tokens: 200000, max_tokens: 32000 };
const catalog = rows => ({ data: rows, has_more: false, first_id: rows[0]?.id ?? "", last_id: rows.at(-1)?.id ?? "" });
const discover = async (provider = {}) => (await plugin()).provider.models(provider, { auth });

test("discovery requests Anthropic format and keeps original IDs and known capabilities", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push([input, init]);
    const headers = new Headers(init.headers);
    // CPA serves OpenAI format without the Anthropic header, even for Claude IDs.
    if (headers.get("anthropic-version") !== "2023-06-01") {
      return Response.json({ object: "list", data: [{ id, object: "model", owned_by: "anthropic" }] });
    }
    return Response.json(catalog([row, { ...row, id: "claude-new", display_name: "New Claude" }]));
  });
  const known = { limit: { context: 123456, output: 23456 }, capabilities: { toolcall: true },
    api: { id: "different-alias", npm: "@ai-sdk/anthropic" } };
  const result = await discover({ models: { [id]: known } });
  assert.deepEqual(Object.keys(result), [id, "claude-new"]);
  assert.equal(result[id].id, id);
  assert.equal(result[id].name, "Claude Sonnet");
  assert.equal(result[id].limit, known.limit);
  assert.equal(result[id].capabilities, known.capabilities);
  assert.equal(result[id].api.id, undefined);
  assert.equal(known.api.id, "different-alias");
  assert.deepEqual(result["claude-new"], { id: "claude-new", name: "New Claude" });
  assert.equal(calls.length, 1);
  const [input, init] = calls[0];
  assert.equal(input, "https://cpa.example.invalid/v1/models");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-api-key"), auth.key);
  assert.ok(!JSON.stringify([...headers]).includes(auth.metadata.managementKey));
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
});

test("keeps non-Claude model IDs and excludes only cloaking-encoded IDs", async t => {
  const ids = [id, "gpt-test", "gemini-test", "custom/claude-alias", "claude-fable-5-dd-tset-tpg"];
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog(ids.map(id => ({ id })))));
  const result = await discover();
  assert.deepEqual(Object.keys(result), ids.slice(0, -1));
  for (const id of ids.slice(0, -1)) assert.deepEqual(result[id], { id, name: id });
});

test("missing authentication makes no model request", async t => {
  const mocked = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  assert.deepEqual(await (await plugin()).provider.models({}), {});
  assert.equal(mocked.mock.callCount(), 0);
});

test("401 and 403 mark business sign-in expired without retrying", async t => {
  for (const status of [401, 403]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => new Response("private error body", { status }));
    await assert.rejects(discover(), error => error.signIn === "expired" && !error.message.includes("private"));
    assert.equal(mocked.mock.callCount(), 1);
    mocked.mock.restore();
  }
});

test("500 and network failures throw ordinary errors for host fallback", async t => {
  for (const response of [new Response("private error body", { status: 500 }), null]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => {
      if (!response) throw new TypeError("fetch failed");
      return response;
    });
    await assert.rejects(discover(), error => !error.signIn && !error.message.includes("private"));
    assert.equal(mocked.mock.callCount(), 1);
    mocked.mock.restore();
  }
});

test("10-second timeout uses a signal and remains a fallback error", async t => {
  let timeout;
  t.mock.method(AbortSignal, "timeout", ms => {
    timeout = ms;
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  t.mock.method(globalThis, "fetch", async (_input, init) => { init.signal.throwIfAborted(); });
  await assert.rejects(discover(), { name: "TimeoutError" });
  assert.equal(timeout, 10000);
});

test("malformed JSON and invalid list fields trigger fallback", async t => {
  for (const body of ["not JSON", "null", "{}", '{"data":null,"has_more":false}',
    JSON.stringify({ data: {} })]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(discover(), error => !error.signIn);
    mocked.mock.restore();
  }
});

test("valid empty and cloaking-only catalogs are successful empty results", async t => {
  for (const rows of [[], [{ ...row, id: "claude-fable-5-dd-encoded" }]]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json(catalog(rows)));
    assert.deepEqual(await discover(), {});
    mocked.mock.restore();
  }
});

test("oversized chunked responses stop reading and cancel the body", async t => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(300000)); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(discover(), /size limit/);
  assert.ok(cancelled);
  assert.ok(pulls <= 6);
});

test("skips malformed rows and tolerates omitted type and has_more metadata", async t => {
  for (const has_more of [undefined, false, true]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json({
      data: [null, {}, { id: "" }, { id: 3 }, { id: "  " }, { id, display_name: "Valid Claude" }], has_more,
    }));
    assert.deepEqual(await discover(), { [id]: { id, name: "Valid Claude" } });
    mocked.mock.restore();
  }
});


test("arbitrary model IDs remain own data properties without changing the model map prototype", async t => {
  const ids = ["__proto__", "constructor", "toString"];
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog(ids.map(id => ({ id })))));
  const models = await discover();
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  assert.deepEqual(Object.keys(models), ids);
  for (const id of ids) assert.deepEqual(models[id], { id, name: id });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(models))), ids);
});
