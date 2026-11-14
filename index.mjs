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

const claudeUsageURL = "https://api.anthropic.com/api/oauth/usage";
const claudeUsageHeader = { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20",
  "User-Agent": "claude-cli/2.1.280 (external, cli)", Accept: "application/json" };
const claudeGrantID = /^[a-z0-9_-]{1,40}$/;

function optionalTime(value) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// Claude usage-limit reset grants ("Reset for free" in Claude Settings > Usage), read from the
// opt-in `cedar_ember` block of the same usage response. Display only: grants are never claimed
// (POST /api/organizations/{org}/reset_rate_limits is never sent). Like CPA's management center,
// one malformed grant rejects the whole block, so a partial list is never shown as complete.
function claudeResets(block, now) {
  if (block === null || typeof block !== "object" || Array.isArray(block) || typeof block.eligible !== "boolean") return;
  const grants = block.grants ?? [];
  if (!Array.isArray(grants)) return;
  const each = [];
  const seen = new Set();
  for (const grant of grants) {
    if (grant === null || typeof grant !== "object") return;
    const { id, resets_left: left, resets_total: total } = grant;
    if (typeof id !== "string" || !claudeGrantID.test(id) || seen.has(id)) return;
    seen.add(id);
    if (!Number.isInteger(left) || left < 0 || left > 100) return;
    if (total !== undefined && (!Number.isInteger(total) || total < left)) return;
    const until = optionalTime(grant.ends_at);
    if (until === undefined || optionalTime(grant.starts_at) === undefined) return;
    if (!left || until && Date.parse(until) <= now) continue;
    const window = grant.type === "session" ? "fiveHour" : grant.type === "weekly" ? "weekly" : undefined;
    for (let i = 0; i < left; i++) {
      const card = {};
      if (until) card.until = until;
      if (window) card.window = window;
      each.push(card);
    }
  }
  if (!each.length) return;
  each.sort((a, b) => a.until === b.until ? 0 : a.until === undefined ? 1 : b.until === undefined ? -1
    : a.until < b.until ? -1 : 1);
  const resets = { count: each.length, each };
  if (each[0].until) resets.until = each[0].until;
  return resets;
}

async function readClaudeUsage(apiCall, _credential, { now, memo = {} }) {
  const plain = () => apiCall({ method: "GET", url: claudeUsageURL, header: claudeUsageHeader });
  let data;
  let inventory = !(memo.plainUntil > now);
  if (!inventory) {
    data = await plain();
  } else {
    try {
      // One request for windows and grants: Anthropic rate-limits this endpoint hard.
      data = await apiCall({ method: "GET", url: claudeUsageURL + "?cedar_ember=1", header: claudeUsageHeader });
    } catch (error) {
      // An account or client the opt-in query is refused for still gets its windows (as CodexBar does),
      // and later reads skip the refused query for a day instead of paying two requests each time.
      if (![400, 403].includes(error?.upstreamStatus)) throw error;
      data = await plain();
      memo.plainUntil = now + 86_400_000;
      inventory = false;
    }
  }
  const reading = { windows: usageWindows(data), inventory };
  const resets = claudeResets(data?.cedar_ember, now);
  if (resets) reading.resets = resets;
  return reading;
}

const readTTL = 300_000;
const inventoryTTL = 1_800_000;
const signalMaxAge = 300_000;

// Anthropic's unified rate-limit headers, which CPA keeps per credential from its latest real
// inference response (`quota.signals` in /credentials). Utilization is a 0-1 share and reset a
// Unix time in seconds. Only a recent, complete and unexpired 5-hour plus 7-day pair is used,
// so these windows cost no Anthropic request at all.
function claudeSignalWindows(credential, now) {
  const quota = credential?.quota;
  const observedAt = typeof quota?.observed_at === "string" ? Date.parse(quota.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || now - observedAt > signalMaxAge || observedAt - now > 60_000) return;
  if (quota.signals === null || typeof quota.signals !== "object") return;
  const signals = new Map();
  for (const [key, value] of Object.entries(quota.signals)) {
    if (typeof value === "string") signals.set(key.toLowerCase(), value.trim());
  }
  const windows = [];
  for (const [key, name, span] of [["5h", "5 hours", 18000], ["7d", "7 days", 604800]]) {
    const used = signals.get("anthropic-ratelimit-unified-" + key + "-utilization") ?? "";
    const reset = signals.get("anthropic-ratelimit-unified-" + key + "-reset") ?? "";
    if (!/^\d{1,6}(\.\d{1,9})?$/.test(used) || !/^\d{1,12}(\.\d{1,9})?$/.test(reset)) return;
    const resetsAt = Math.round(Number(reset) * 1000);
    if (resetsAt <= now || resetsAt > 8.64e15) return;
    windows.push({ name, used: Math.round(Number(used) * 10_000) / 100, span, resetsAt: new Date(resetsAt).toISOString() });
  }
  return { windows, observedAt };
}

// Quota adapters keyed by CPA's `files[].provider`. read(apiCall, credential, { now, memo }) returns
// { windows, resets?, inventory? } where apiCall sends one inner request through CPA's management
// api-call and memo persists per credential; passive(credential, now) may return { windows,
// observedAt } from data CPA already holds, without any upstream request.
const usageAdapters = {
  claude: { read: readClaudeUsage, passive: claudeSignalWindows },
};

function managementScope(base, metadata) {
  return base + "|" + createHash("sha256").update(metadata.managementKey).digest("hex").slice(0, 12);
}

function liveResets(resets, now) {
  if (!resets || !Array.isArray(resets.each)) return resets;
  const each = resets.each.filter(card => !card.until || Date.parse(card.until) > now);
  if (!each.length) return;
  const live = { count: each.length, each };
  if (each[0].until) live.until = each[0].until;
  return live;
}

function retryAfter(header, now) {
  if (header === null || typeof header !== "object") return;
  for (const [key, values] of Object.entries(header)) {
    if (key.toLowerCase() !== "retry-after") continue;
    const value = String(Array.isArray(values) ? values[0] : values).trim();
    const ms = /^\d{1,9}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
}

// Repeated upstream failures double the 300s pause up to an hour; a longer Retry-After wins up to that cap.
function upstreamDelay(error, failures) {
  const backoff = Math.min(readTTL * 2 ** Math.min(failures - 1, 4), 3_600_000);
  return Math.min(Math.max(backoff, error?.retryAfter ?? 0), 3_600_000);
}

function createUsage({ request = (...args) => fetch(...args), now = () => Date.now(),
  timeout = ms => AbortSignal.timeout(ms), adapters = usageAdapters, blocked = new Map() } = {}) {
  const cache = new Map(); // per Magpie selection: the rendered reading
  const lists = new Map(); // per management scope: one credential list shared for 15s
  const upstream = new Map(); // per CPA credential: upstream readings shared by every selection
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
      const scope = managementScope(base, metadata);
      if (blocked.has(scope)) return { error: blocked.get(scope), signIn: "kept" };
      const key = JSON.stringify([scope, selection]);
      let entry = cache.get(key);
      if (!entry) { entry = {}; cache.set(key, entry); }
      if (entry.pending) return await within(entry.pending, signal);
      if (entry.value && now() - entry.updatedAt < readTTL || now() < entry.retryAt) return render(entry);
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
      // Accounts on one CPA refreshed together share a single credential list.
      const credentialList = () => {
        let list = lists.get(scope);
        if (!list || now() - list.at >= 15_000) {
          list = { at: now(), files: call("/credentials", 1 << 20).then(credentials => {
            if (!Array.isArray(credentials?.files)) throw new UsageError("Invalid CPA credential list", { stale: false });
            return credentials.files;
          }) };
          lists.set(scope, list);
          list.files.catch(() => { if (lists.get(scope) === list) lists.delete(scope); });
        }
        return within(list.files, signal);
      };
      // Upstream reads are cached per credential, so every selection naming it shares one reading,
      // one in-flight request and one backoff. CPA's passive signals supply the windows when they
      // are recent; the reset inventory then needs a fresh read only every 30 minutes.
      const credentialReading = async (credential, adapter, apiCall) => {
        const upstreamKey = JSON.stringify([scope, credential.auth_index]);
        let state = upstream.get(upstreamKey);
        if (!state) { state = { memo: {}, failures: 0, retryAt: 0 }; upstream.set(upstreamKey, state); }
        const t = now();
        const passive = adapter.passive?.(credential, t);
        const last = state.reading;
        const age = last ? t - state.readAt : Infinity;
        const fromPassive = () => ({ windows: passive.windows,
          resets: age < inventoryTTL ? liveResets(last.resets, t) : undefined });
        if (age < readTTL) {
          return passive && passive.observedAt > state.readAt ? fromPassive()
            : { windows: last.windows, resets: liveResets(last.resets, t) };
        }
        if (passive && last && (!last.inventory || age < inventoryTTL)) return fromPassive();
        if (!state.pending && t < state.retryAt) {
          if (passive) return fromPassive();
          throw state.error;
        }
        state.pending ??= (async () => {
          try {
            const reading = await adapter.read(apiCall, credential, { now: t, memo: state.memo });
            Object.assign(state, { reading, readAt: now(), failures: 0, retryAt: 0, error: undefined });
            return reading;
          } catch (error) {
            state.failures++;
            state.error = error instanceof UsageError ? error : new UsageError("CPA upstream usage request failed; retry later");
            state.retryAt = now() + upstreamDelay(error, state.failures);
            throw error;
          } finally { state.pending = undefined; }
        })();
        try {
          const reading = await within(state.pending, signal);
          return { windows: reading.windows, resets: liveResets(reading.resets, now()) };
        } catch (error) {
          if (passive) return fromPassive();
          throw error;
        }
      };
      entry.pending = (async () => {
        try {
          const files = await credentialList();
          const rows = files.filter(row => row?.disabled === false);
          const supported = row => Object.hasOwn(adapters, row.provider);
          const matches = selection ? rows.filter(row => row.auth_index === selection || row.name === selection)
            : rows.filter(supported);
          if (!matches.length) throw new UsageError(selection ? "Selected CPA credential is missing or disabled"
            : rows.length ? "Quota is not supported for this provider yet" : "No enabled CPA credential found", { stale: false });
          if (matches.length !== 1) throw new UsageError("Multiple CPA credentials; choose a unique name or auth_index", { stale: false });
          const credential = matches[0];
          if (!supported(credential)) throw new UsageError("Quota is not supported for this provider yet", { stale: false });
          const adapter = adapters[credential.provider];
          if (typeof credential.auth_index !== "string" || !credential.auth_index.trim() || credential.auth_index.length > 128) {
            throw new UsageError("Invalid CPA auth_index; check the selected credential", { stale: false });
          }
          const apiCall = async template => {
            const payload = await call("/requests/api-call", 256 << 10, {
              ...template, auth_index: credential.auth_index,
            });
            if (payload?.status_code !== 200) {
              const status = payload?.status_code;
              const error = new UsageError(status === 401 ? "CPA upstream credential rejected; refresh it in CPA"
                : status === 429 ? "CPA upstream usage request rate-limited; retry later"
                  : "CPA upstream usage request failed; retry later");
              error.upstreamStatus = status;
              error.retryAfter = retryAfter(payload?.header, now());
              throw error;
            }
            if (typeof payload.body !== "string") throw new UsageError("Invalid CPA usage response");
            return JSON.parse(payload.body);
          };
          const reading = await credentialReading(credential, adapter, apiCall);
          // Copies, so labelling never alters the reading other selections share.
          const label = rows.length > 1 &&
            ([credential.label, credential.name].find(value => typeof value === "string" && value.trim()) || "selected");
          const windows = reading.windows.map(window => label
            ? { ...window, name: window.name + " (credential " + label + ")", aside: true } : { ...window });
          entry.value = { windows, signIn: "kept" };
          if (reading.resets) entry.value.resets = reading.resets;
          entry.updatedAt = now();
          entry.error = undefined;
        } catch (error) {
          entry.error = error instanceof UsageError ? error.message : signal.aborted
            ? "CPA usage timed out; check management access" : "CPA usage unavailable; check management access";
          if (error instanceof UsageError && (!error.stale || error.permanent)) entry.value = undefined;
          entry.retryAt = now() + readTTL;
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

// Management 401/403 counts toward CPA's per-IP ban (5 failures, 30 minutes), so discovery
// shares the usage hook's rejection breaker instead of retrying a rejected key on every refresh.
async function modelDefinitions(auth, blocked = new Map()) {
  const metadata = auth?.metadata;
  if (typeof metadata?.managementKey !== "string" || !metadata.managementKey) return new Map();
  try {
    const base = managementBase(metadata);
    const scope = managementScope(base, metadata);
    if (blocked.has(scope)) return new Map();
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(base + "/routing/model-definitions/claude", {
      headers: managementHeaders(metadata), signal, redirect: "error",
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        blocked.set(scope, "CPA management access rejected; check key and remote access");
      }
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
  const rejectedManagement = new Map();
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider.cpa ??= { name: "CLIProxyAPI", npm: "@ai-sdk/anthropic", models: {} };
    },
    auth: {
      provider: "cpa",
      usage: createUsage({ blocked: rejectedManagement }),
      methods: [{
        type: "api",
        label: "CLIProxyAPI business API key",
        prompts: [
          { type: "text", key: "baseURL", message: "CPA Base URL", validate: validateURL },
          { type: "password", key: "businessKey", message: "Business API key",
            validate: value => typeof value === "string" && value.trim() ? undefined : "Business API key is required" },
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
            // Return the prompted key explicitly; API account labels use metadata.email.
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
        const definitionsPromise = modelDefinitions(auth, rejectedManagement);
        const response = await fetch(baseURL + "/v1/models", {
          headers: { "x-api-key": auth.key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error("CPA model discovery failed (HTTP " + response.status + ")");
          if ([401, 403].includes(response.status)) error.signIn = "expired";
          throw error;
        }
        const [payload, definitions] = await Promise.all([
          readJSON(response, 1 << 20), definitionsPromise,
        ]);
        if (!Array.isArray(payload?.data)) {
          throw new Error("Invalid CPA model list");
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
