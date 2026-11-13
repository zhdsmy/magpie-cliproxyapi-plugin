import { createHash } from "node:crypto";

function normalizeURL(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("A CPA URL is required");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter an absolute HTTP or HTTPS URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("Use HTTP or HTTPS without credentials, query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.href.replace(/\/+$/, "");
}

function validateURL(value, optional = false) {
  if (optional && !value?.trim()) return;
  try { normalizeURL(value); } catch (error) { return error.message; }
}

function managementBase(metadata) {
  return metadata.managementURL ? normalizeURL(metadata.managementURL)
    : normalizeURL(metadata.baseURL) + "/v8/management";
}

function managementHeaders(metadata) {
  return { Authorization: "Bearer " + metadata.managementKey, "Content-Type": "application/json" };
}

async function readJSON(response, maxBytes) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("CPA response exceeds size limit");
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

class UsageError extends Error {
  constructor(message, { permanent = false, stale = true } = {}) {
    super(message);
    this.permanent = permanent;
    this.stale = stale;
  }
}

function within(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

function usageWindows(data) {
  const windows = [];
  for (const [key, name, span] of [["five_hour", "5 hours", 18000], ["seven_day", "7 days", 604800]]) {
    const row = data?.[key];
    const used = row?.utilization;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    const window = { name, used, span };
    if (row.resets_at === null && used === 0) {
      // A window which has not started has no reset time yet.
    } else {
      const reset = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
      if (!Number.isFinite(reset)) continue;
      window.resetsAt = new Date(reset).toISOString();
    }
    windows.push(window);
  }
  if (!windows.length) throw new UsageError("CPA returned no valid quota windows; check the selected credential");
  return windows;
}

const usageAdapters = {
  codex: {
    request: {
      method: "GET", url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$", Accept: "application/json" },
    },
    parse(data) {
      const plan = typeof data?.plan_type === "string" && /^[a-z0-9_-]{1,30}$/i.test(data.plan_type) ? data.plan_type : "unknown";
      const windows = [];
      for (const row of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
        if (!row || typeof row.used_percent !== "number" || !Number.isFinite(row.used_percent) || row.used_percent < 0 ||
            !Number.isSafeInteger(row.limit_window_seconds) || row.limit_window_seconds <= 0) continue;
        const days = row.limit_window_seconds / 86400;
        const hours = row.limit_window_seconds / 3600;
        const duration = Number.isInteger(days) ? days + "d" : Number.isInteger(hours) ? hours + "h" : row.limit_window_seconds + "s";
        const window = { name: plan[0].toUpperCase() + plan.slice(1) + "/" + duration, used: row.used_percent, span: row.limit_window_seconds };
        if (Number.isFinite(row.reset_at) && row.reset_at > 0 && row.reset_at < 8640000000000) window.resetsAt = new Date(row.reset_at * 1000).toISOString();
        windows.push(window);
      }
      if (!windows.length) throw new UsageError("CPA returned no valid Codex quota windows");
      return windows;
    },
  },
  claude: {
    request: {
      method: "GET", url: "https://api.anthropic.com/api/oauth/usage",
      header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/2.1.280 (external, cli)", Accept: "application/json" },
    },
    parse: usageWindows,
  },
};

function createUsage({ request = (...args) => fetch(...args), now = () => Date.now(),
  timeout = ms => AbortSignal.timeout(ms), adapters = usageAdapters } = {}) {
  const cache = new Map();
  const blocked = new Map();
  const render = entry => entry.value && (!entry.error || now() - entry.updatedAt <= 900_000)
    ? entry.value : { error: entry.error, signIn: "kept" };
  return async getAuth => {
    try {
      const signal = timeout(15_000);
      const auth = await within(Promise.resolve().then(getAuth), signal);
      const metadata = auth?.metadata;
      if (auth?.type !== "api" || !metadata?.managementKey) return {};
      if (typeof metadata.managementKey !== "string") throw new UsageError("Check the CPA management key");
      const base = managementBase(metadata);
      const selection = metadata.credential ?? "";
      if (typeof selection !== "string") throw new UsageError("Check the CPA credential selection");
      const scope = base + "|" + createHash("sha256").update(metadata.managementKey).digest("hex").slice(0, 12);
      if (blocked.has(scope)) return { error: blocked.get(scope), signIn: "kept" };
      const key = JSON.stringify([scope, selection]);
      let entry = cache.get(key);
      if (!entry) { entry = {}; cache.set(key, entry); }
      if (entry.pending) return await within(entry.pending, signal);
      if (entry.value && now() - entry.updatedAt < 300_000 || now() < entry.retryAt) return render(entry);
      const call = (path, maxBytes, body) => within((async () => {
        signal.throwIfAborted();
        const response = await request(base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: managementHeaders(metadata),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error", signal,
        });
        if (response.status !== 200) {
          const permanent = [401, 403].includes(response.status);
          const message = permanent ? "CPA management access rejected; check key and remote access"
            : "CPA management request failed (HTTP " + response.status + "); retry later";
          if (permanent) blocked.set(scope, message);
          try { await response.body?.cancel(); } catch {}
          throw new UsageError(message, { permanent });
        }
        return readJSON(response, maxBytes);
      })(), signal);
      entry.pending = (async () => {
        try {
          const credentials = await call("/credentials", 1 << 20);
          if (!Array.isArray(credentials?.files)) throw new UsageError("Invalid CPA credential list", { stale: false });
          const rows = credentials.files.filter(row => row?.disabled === false);
          const supported = row => Object.hasOwn(adapters, row.provider);
          const matches = selection ? rows.filter(row => row.auth_index === selection || row.name === selection)
            : rows.filter(supported);
          if (!matches.length) throw new UsageError(selection ? "Selected CPA credential is missing or disabled"
            : rows.length ? "Quota is not supported for this provider yet" : "No enabled CPA credential found", { stale: false });
          const codexPool = !selection && matches.some(row => row.provider === "codex") &&
            matches.every(row => row.provider === "codex" || row.provider === "claude");
          if (matches.length !== 1 && !codexPool) throw new UsageError("Multiple CPA credentials; choose a unique name or auth_index", { stale: false });
          if (codexPool) matches.sort((a, b) => String(a.auth_index).localeCompare(String(b.auth_index)));
          for (const credential of matches) {
            if (!supported(credential)) throw new UsageError("Quota is not supported for this provider yet", { stale: false });
            if (typeof credential.auth_index !== "string" || !credential.auth_index.trim() || credential.auth_index.length > 128) {
              throw new UsageError("Invalid CPA auth_index; check the selected credential", { stale: false });
            }
          }
          const windows = [];
          for (const [index, credential] of matches.entries()) {
            const adapter = adapters[credential.provider];
            const payload = await call("/requests/api-call", 256 << 10, {
              ...adapter.request, auth_index: credential.auth_index,
            });
            if (payload?.status_code !== 200) {
              throw new UsageError(payload?.status_code === 401 ? "CPA upstream credential rejected; refresh it in CPA"
                : "CPA upstream usage request failed; retry later");
            }
            if (typeof payload.body !== "string") throw new UsageError("Invalid CPA usage response");
            const credentialWindows = adapter.parse(JSON.parse(payload.body));
            if (credential.provider === "codex" || credential.provider === "claude") {
              for (const window of credentialWindows) {
                if (credential.provider === "claude") window.name = window.name.replace("5 hours", "5h").replace("7 days", "7d");
                window.name = (credential.provider === "codex" ? "Codex" : "Claude") + "/" + window.name;
              }
            }
            if (rows.length > 1) {
              const label = [credential.label, credential.name].find(value => typeof value === "string" && value.trim());
              for (const window of credentialWindows) {
                if (codexPool) window.name += "/#" + (index + 1);
                else if (credential.provider === "claude" || credential.provider === "codex") window.name += "/" + (label || "selected");
                else window.name += " (credential " + (label || "selected") + ")";
                window.aside = true;
              }
            }
            windows.push(...credentialWindows);
          }
          const planOrder = window => /^Codex\/plus\//i.test(window.name) ? 0 : /^Codex\/free\//i.test(window.name) ? 2 : 1;
          windows.sort((a, b) => planOrder(a) - planOrder(b));
          entry.value = { windows, signIn: "kept" };
          entry.updatedAt = now();
          entry.error = undefined;
        } catch (error) {
          entry.error = error instanceof UsageError ? error.message : signal.aborted
            ? "CPA usage timed out; check management access" : "CPA usage unavailable; check management access";
          if (error instanceof UsageError && (!error.stale || error.permanent)) entry.value = undefined;
          entry.retryAt = now() + 300_000;
        } finally { entry.pending = undefined; }
        return render(entry);
      })();
      return await within(entry.pending, signal);
    } catch {
      return { error: "CPA usage unavailable; check management configuration", signIn: "kept" };
    }
  };
}

function definitionBase(id) {
  return id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

function reasoningLevels(definition) {
  if (!Array.isArray(definition?.thinking?.levels)) return [];
  return [...new Set(definition.thinking.levels
    .filter(level => typeof level === "string")
    .map(level => level.trim())
    .filter(Boolean))];
}

async function modelDefinitions(auth) {
  const metadata = auth?.metadata;
  if (typeof metadata?.managementKey !== "string" || !metadata.managementKey) return new Map();
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(managementBase(metadata) + "/routing/model-definitions/claude", {
      headers: managementHeaders(metadata), signal, redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return new Map();
    }
    const payload = await readJSON(response, 1 << 20);
    if (!Array.isArray(payload?.models)) return new Map();
    const definitions = new Map();
    for (const definition of payload.models) {
      if (typeof definition?.id !== "string" || !definition.id.trim()) continue;
      definitions.set(definition.id, definition);
    }
    return definitions;
  } catch {
    return new Map();
  }
}

function applyReasoning(model, definition, configured) {
  const levels = reasoningLevels(definition);
  if (!levels.length) return model;
  if (!Object.hasOwn(configured ?? {}, "variants")) {
    model.variants = Object.fromEntries(levels.map(level => [level, {}]));
  }
  if (!Object.hasOwn(configured?.capabilities ?? {}, "reasoning")) {
    model.capabilities = { ...model.capabilities, reasoning: true };
  }
  return model;
}

export default async function CLIProxyAPIPlugin() {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider.cpa ??= { name: "CLIProxyAPI", npm: "@ai-sdk/anthropic", models: {} };
    },
    auth: {
      provider: "cpa",
      usage: createUsage(),
      methods: [{
        type: "api",
        label: "CLIProxyAPI business API key",
        prompts: [
          { type: "text", key: "baseURL", message: "CPA Base URL", validate: validateURL },
          { type: "password", key: "businessKey", message: "Business API key", validate: value => typeof value === "string" && value.trim() ? undefined : "Business API key is required" },
          { type: "password", key: "managementKey", message: "Management key (optional, for usage)" },
          { type: "text", key: "managementURL", message: "Management URL (optional)",
            validate: value => validateURL(value, true) },
          { type: "text", key: "credential", message: "CPA credential name or auth_index (optional)" },
        ],
        async authorize(inputs) {
          try {
            const baseURL = normalizeURL(inputs?.baseURL);
            const key = inputs?.businessKey?.trim();
            if (!key) return { type: "failed", error: "Business API key is required" };
            const metadata = { baseURL, email: "cpa@" + new URL(baseURL).host };
            const managementURL = inputs?.managementURL?.trim();
            if (managementURL) metadata.managementURL = normalizeURL(managementURL);
            for (const field of ["managementKey", "credential"]) {
              const value = inputs?.[field]?.trim();
              if (value) metadata[field] = value;
            }
            return { type: "success", key, metadata };
          } catch {
            return { type: "failed", error: "Invalid CPA or management URL" };
          }
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return {};
        const baseURL = normalizeURL(auth.metadata?.baseURL);
        return {
          baseURL: baseURL + "/v1",
          apiKey: auth.key,
          fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
        };
      },
    },
    provider: {
      id: "cpa",
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return {};
        const baseURL = normalizeURL(auth.metadata?.baseURL);
        const definitionsPromise = modelDefinitions(auth);
        const fetchModels = headers => fetch(baseURL + "/v1/models", {
          headers, signal: AbortSignal.timeout(10_000), redirect: "error",
        });
        const response = await fetchModels({ "x-api-key": auth.key, "anthropic-version": "2023-06-01" });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error("CPA model discovery failed (HTTP " + response.status + ")");
          if ([401, 403].includes(response.status)) error.signIn = "expired";
          throw error;
        }
        let [payload, definitions] = await Promise.all([
          readJSON(response, 1 << 20), definitionsPromise,
        ]);
        if (!Array.isArray(payload?.data)) {
          throw new Error("Invalid CPA model list");
        }
        if (payload.data.length && payload.data.every(row => typeof row?.id === "string" && row.id.startsWith("claude-fable-5-dd-"))) {
          const fallback = await fetchModels({ Authorization: "Bearer " + auth.key });
          if (!fallback.ok) {
            await fallback.body?.cancel();
            const error = new Error("CPA model discovery failed (HTTP " + fallback.status + ")");
            if ([401, 403].includes(fallback.status)) error.signIn = "expired";
            throw error;
          }
          payload = await readJSON(fallback, 1 << 20);
          if (!Array.isArray(payload?.data)) throw new Error("Invalid CPA model list");
        }
        const models = {};
        for (const row of payload.data) {
          if (typeof row?.id !== "string" || !row.id.trim()) continue;
          if (row.id.startsWith("claude-fable-5-dd-")) continue;
          const configured = provider?.models?.[row.id];
          const definition = definitions.get(row.id) ?? definitions.get(definitionBase(row.id));
          const model = { ...configured, id: row.id,
            name: typeof row.display_name === "string" && row.display_name ? row.display_name : row.id };
          applyReasoning(model, definition, configured);
          if (model.api) {
            const { id: _id, ...api } = model.api;
            model.api = api;
          }
          Object.defineProperty(models, row.id, { value: model, enumerable: true, configurable: true, writable: true });
        }
        return models;
      },
    },
  };
}

export const _internal = { normalizeURL, createUsage };
