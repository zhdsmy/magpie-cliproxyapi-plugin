import { createServer } from "node:http";
import { once } from "node:events";

export async function createMockCPA(port = 0, options = {}) {
  const state = { mode: "normal", managementMode: "normal", requests: [], cancellations: 0,
    models: options.models ?? ["claude-sonnet-4-6"], used: options.used ?? 25, weekUsed: options.weekUsed ?? 50 };
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/__state") return json(200, state);
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 65536) return json(413, { error: "test body too large" });
    }
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(400, { error: "invalid JSON" }); }
    if (request.url === "/__mode") {
      if (body.mode) state.mode = body.mode;
      if (body.managementMode) state.managementMode = body.managementMode;
      if (Array.isArray(body.models) && body.models.every(id => typeof id === "string")) state.models = body.models;
      if (Number.isFinite(body.used)) state.used = body.used;
      if (Number.isFinite(body.weekUsed)) state.weekUsed = body.weekUsed;
      return json(200, { mode: state.mode, managementMode: state.managementMode });
    }
    state.requests.push({ mode: state.mode, at: Date.now(), path: request.url, method: request.method, headers: request.headers, model: body.model, body });
    if (request.url.startsWith("/v8/management/")) {
      if (state.managementMode === "denied" || request.headers.authorization !== "Bearer test-mgmt-key-LEAKCHECK") {
        return json(401, { error: "test management key rejected" });
      }
      if (state.managementMode === "unavailable") return json(503, { error: "test management unavailable" });
      if (request.url === "/v8/management/credentials") {
        const first = { provider: "claude", disabled: false, auth_index: "index-one", name: "one", label: "First" };
        const files = [first];
        if (state.managementMode === "multi") files.push({ ...first, auth_index: "index-two", name: "two", label: "Second" });
        return json(200, { files });
      }
      if (request.url === "/v8/management/requests/api-call") {
        const expected = { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.280 (external, cli)", Accept: "application/json" };
        if (request.method !== "POST" || !["index-one", "index-two"].includes(body.auth_index) || body.method !== "GET" ||
            body.url !== "https://api.anthropic.com/api/oauth/usage?cedar_ember=1" ||
            Object.keys(body.header ?? {}).length !== 4 || Object.entries(expected).some(([k, v]) => body.header?.[k] !== v)) {
          return json(400, { error: "invalid test api-call template" });
        }
        const usage = { five_hour: { utilization: state.used, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: state.weekUsed, resets_at: new Date(Date.now() + 86400_000).toISOString() } };
        return json(200, { status_code: state.managementMode === "inner401" ? 401 : 200, body: JSON.stringify(usage) });
      }
      return json(404, { error: "test management route not found" });
    }
    if (request.headers["x-api-key"] !== "test-biz-key-sandbox" &&
        request.headers.authorization !== "Bearer test-biz-key-sandbox") return json(401, { error: "test auth required" });
    if (request.url === "/v1/models") {
      if (!request.headers["anthropic-version"]) return json(200, { object: "list", data: state.models.map(id => ({ id, object: "model" })) });
      return json(200, { data: state.models.map(id => ({ id, type: "model", display_name: id })),
        has_more: false, first_id: state.models[0], last_id: state.models.at(-1) });
    }
    if (!state.models.includes(body.model)) return json(404, { type: "error", error: { type: "not_found_error", message: "test model not served" } });
    if (request.url === "/v1/messages/count_tokens") return json(200, { input_tokens: 7 });
    if (request.url !== "/v1/messages") return json(404, { error: "not found" });
    if (state.mode === "503") return json(503, { type: "error", error: { type: "api_error", message: "test unavailable" } });
    if (state.mode === "disconnect") { request.socket.destroy(); return; }
    if (["429", "walled429"].includes(state.mode)) return json(429, { type: "error", error: {
      type: "rate_limit_error", message: "test 429",
      ...(state.mode === "walled429" ? { code: "user_model_rate_limited" } : {}),
    } });
    const usage = { input_tokens: 3, output_tokens: 1, ...(options.cacheRead ? { cache_read_input_tokens: options.cacheRead } : {}) };
    const toolResult = body.messages?.some(message => Array.isArray(message.content) &&
      message.content.some(block => block.type === "tool_result"));
    const isTool = body.tools?.length && !toolResult;
    const content = isTool ? [{ type: "tool_use", id: "tool_test", name: body.tools[0].name, input: { value: "test" } }]
      : [{ type: "text", text: "pong" }];
    const stopReason = isTool ? "tool_use" : "end_turn";
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (type, fields) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n");
      emit("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
      emit("content_block_start", { index: 0, content_block: isTool
        ? { ...content[0], input: {} } : { type: "text", text: "" } });
      if (state.mode === "slow") {
        const timer = setInterval(() => emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }), 50);
        response.on("close", () => { clearInterval(timer); state.cancellations++; });
        return;
      }
      emit("content_block_delta", { index: 0, delta: isTool
        ? { type: "input_json_delta", partial_json: JSON.stringify(content[0].input) }
        : { type: "text_delta", text: "pong" } });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
      emit("message_stop", {});
      return response.end();
    }
    const result = { id: "msg_test", type: "message", role: "assistant", model: body.model,
      content, stop_reason: stopReason, stop_sequence: null, usage };
    return json(200, result);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { server, state, origin: "http://127.0.0.1:" + server.address().port };
}
