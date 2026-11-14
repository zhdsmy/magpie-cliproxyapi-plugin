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

function codexPlan(value) {
  return ["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"].includes(value) ? value : undefined;
}

function codexWindows(data, now) {
  const windows = [];
  for (const row of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
    if (typeof row?.used_percent !== "number" || !Number.isFinite(row.used_percent) ||
        row.used_percent < 0 || row.used_percent > 100 ||
        !Number.isSafeInteger(row.limit_window_seconds) || row.limit_window_seconds <= 0) continue;
    let reset = row.reset_at;
    if (reset == null && row.reset_after_seconds != null) {
      const after = row.reset_after_seconds;
      if (typeof after !== "number" || !Number.isFinite(after) || after < 0) continue;
      reset = now / 1000 + after;
    }
    if (reset != null && (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset > 8.64e12)) continue;
    const span = row.limit_window_seconds;
    const [unit, seconds] = [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]]
      .find(([, seconds]) => span % seconds === 0);
    const count = span / seconds;
    const window = { name: count + " " + unit + (count === 1 ? "" : "s"), used: row.used_percent, span };
    if (reset != null) window.resetsAt = new Date(reset * 1000).toISOString();
    windows.push(window);
  }
  if (!windows.length) throw new UsageError("CPA returned no valid Codex quota windows");
  return windows;
}

async function readCodexUsage(apiCall, credential, { now }) {
  const header = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)" };
  const accountId = credential.id_token?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.trim() && !/[\r\n]/.test(accountId)) {
    header["Chatgpt-Account-Id"] = accountId.trim();
  }
  const data = await apiCall({ method: "GET", url: "https://chatgpt.com/backend-api/wham/usage", header });
  return { windows: codexWindows(data, now), plan: codexPlan(data?.plan_type) };
}

function codexSignalWindows(credential, now) {
  const quota = credential?.quota;
  const observedAt = typeof quota?.observed_at === "string" ? Date.parse(quota.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || now - observedAt > signalMaxAge || observedAt - now > 60_000) return;
  if (quota.signals === null || typeof quota.signals !== "object") return;
  const signals = new Map(Object.entries(quota.signals)
    .filter(([, value]) => typeof value === "string").map(([key, value]) => [key.toLowerCase(), value.trim()]));
  const number = key => /^\d{1,12}(\.\d{1,9})?$/.test(signals.get(key) ?? "") ? Number(signals.get(key)) : NaN;
  const rate_limit = {};
  for (const key of ["primary", "secondary"]) {
    const prefix = "x-codex-" + key + "-";
    const reset = number(prefix + "reset-at");
    const resetAfter = number(prefix + "reset-after-seconds");
    const reset_at = Number.isFinite(reset) ? reset : observedAt / 1000 + resetAfter;
    if (!Number.isFinite(reset_at) || reset_at * 1000 <= now) return;
    rate_limit[key + "_window"] = { used_percent: number(prefix + "used-percent"),
      limit_window_seconds: number(prefix + "window-minutes") * 60, reset_at };
  }
  try {
    const windows = codexWindows({ rate_limit });
    if (windows.length !== 2) return;
    return { windows, observedAt, plan: codexPlan(signals.get("x-codex-plan-type")), inventory: false };
  } catch { return; }
}

function credentialLabel(credential) {
  const provider = credential.provider === "claude" ? "Claude" : credential.provider === "codex" ? "Codex" : credential.provider;
  const label = typeof credential.label === "string" ? credential.label.trim() : "";
  return provider + " " + (label && !/[@\x00-\x1f\x7f]/.test(label) ? label : String(credential.auth_index).slice(0, 8));
}

// Quota adapters keyed by CPA's `files[].provider`. read(apiCall, credential, { now, memo }) returns
// { windows, resets?, plan?, inventory? } where apiCall sends one inner request through CPA's management
// api-call and memo persists per credential; passive(credential, now) may return { windows,
// observedAt, plan?, inventory? } from CPA data; inventory: false needs no active inventory read.
const usageAdapters = {
  claude: { read: readClaudeUsage, passive: claudeSignalWindows },
  codex: { read: readCodexUsage, passive: codexSignalWindows },
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
  const activeReads = new Map(); // per management scope: at most two upstream credential reads
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
        if (blocked.has(scope)) throw new UsageError(blocked.get(scope), { permanent: true });
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
          plan: passive.plan ?? last?.plan,
          resets: age < inventoryTTL ? liveResets(last?.resets, t) : undefined });
        if (age < readTTL) {
          return passive && passive.observedAt > state.readAt ? fromPassive()
            : { windows: last.windows, plan: last.plan, resets: liveResets(last.resets, t) };
        }
        if (passive && (passive.inventory === false || last && (!last.inventory || age < inventoryTTL))) return fromPassive();
        if (!state.pending && t < state.retryAt) {
          if (passive) return fromPassive();
          throw state.error;
        }
        state.pending ??= (async () => {
          let release, slot;
          const active = activeReads.get(scope) ?? new Set();
          activeReads.set(scope, active);
          try {
            while (active.size >= 2) await within(Promise.race(active), signal);
            signal.throwIfAborted();
            if (blocked.has(scope)) throw new UsageError(blocked.get(scope), { permanent: true });
            slot = new Promise(resolve => { release = resolve; });
            active.add(slot);
            const reading = await adapter.read(apiCall, credential, { now: t, memo: state.memo });
            Object.assign(state, { reading, readAt: now(), failures: 0, retryAt: 0, error: undefined });
            return reading;
          } catch (error) {
            state.failures++;
            state.error = error instanceof UsageError ? error : new UsageError("CPA upstream usage request failed; retry later");
            state.retryAt = now() + upstreamDelay(error, state.failures);
            throw error;
          } finally {
            if (slot) { active.delete(slot); release(); }
            state.pending = undefined;
          }
        })();
        try {
          const reading = await within(state.pending, signal);
          return { windows: reading.windows, plan: reading.plan, resets: liveResets(reading.resets, now()) };
        } catch (error) {
          if (error?.permanent) throw error;
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
          if (selection && matches.length !== 1) throw new UsageError("Multiple CPA credentials; choose a unique name or auth_index", { stale: false });
          if (rows.length > 1 && entry.value?.windows.some(window => !window.aside)) entry.value = undefined;
          matches.sort((a, b) => a.provider.localeCompare(b.provider) || credentialLabel(a).localeCompare(credentialLabel(b)) ||
            String(a.auth_index).localeCompare(String(b.auth_index)));
          const read = async credential => {
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
            return credentialReading(credential, adapter, apiCall);
          };
          const readings = await Promise.all(matches.map(async credential => {
            try {
              if (blocked.has(scope)) throw new UsageError(blocked.get(scope), { permanent: true });
              signal.throwIfAborted();
              return { reading: await read(credential) };
            } catch (error) {
              if (error?.permanent || blocked.has(scope)) throw new UsageError(blocked.get(scope) ?? error.message, { permanent: true });
              return { error };
            }
          }));
          if (blocked.has(scope)) throw new UsageError(blocked.get(scope), { permanent: true });
          const successes = readings.filter(result => result.reading);
          if (!successes.length) throw readings[0].error;
          // Copies, so labels never alter the readings other selections share.
          const windows = readings.flatMap(({ reading, error }, index) => {
            const label = credentialLabel(matches[index]);
            if (error) return [{ name: label, display: "Quota unavailable; check credential in CPA", aside: true }];
            return reading.windows.map(window => rows.length > 1
              ? { ...window, name: window.name + " (" + label + ")", aside: true } : { ...window });
          });
          entry.value = { windows, signIn: "kept" };
          if (matches.length === 1) {
            const reading = successes[0].reading;
            if (reading.resets) entry.value.resets = reading.resets;
            if (reading.plan) entry.value.plan = reading.plan;
          }
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
        const signal = AbortSignal.timeout(10_000);
        const fetchModels = async headers => {
          const response = await fetch(baseURL + "/v1/models", { headers, signal, redirect: "error" });
          if (!response.ok) {
            try { await response.body?.cancel(); } catch {}
            const error = new Error("CPA model discovery failed (HTTP " + response.status + ")");
            if ([401, 403].includes(response.status)) error.signIn = "expired";
            throw error;
          }
          const payload = await readJSON(response, 1 << 20);
          if (!Array.isArray(payload?.data)) {
            throw new Error("Invalid CPA model list");
          }
          return payload.data;
        };
        // OpenAI lists original IDs; Anthropic supplies display names but may cloak non-Claude IDs.
        const [lists, definitions] = await Promise.all([
          Promise.allSettled([
            fetchModels({ Authorization: "Bearer " + auth.key }),
            fetchModels({ "x-api-key": auth.key, "anthropic-version": "2023-06-01" }),
          ]),
          definitionsPromise,
        ]);
        const failure = lists.find(result => result.status === "rejected" && result.reason?.signIn === "expired")
          ?? (lists[0].status === "rejected" ? lists[0] : undefined);
        if (failure) throw failure.reason;
        const rows = lists[0].value;
        const namedRows = lists[1].value ?? [];
        const names = new Map(namedRows.filter(row => typeof row?.id === "string")
          .map(row => [row.id, row.display_name]));
        const models = {};
        for (const row of rows) {
          if (typeof row?.id !== "string" || !row.id.trim()) continue;
          if (row.id.startsWith("claude-fable-5-dd-")) continue;
          const configured = provider?.models?.[row.id];
          const definition = definitions.get(row.id) ?? definitions.get(definitionBase(row.id));
          const name = names.get(row.id);
          const model = { ...configured, id: row.id,
            name: typeof name === "string" && name ? name : row.id };
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
