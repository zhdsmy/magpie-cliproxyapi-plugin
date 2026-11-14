# magpie-cliproxyapi-plugin

[中文](README.md)

A Magpie provider plugin for CLIProxyAPI (CPA). **This plugin focuses on Claude via CLIProxyAPI**: inference goes through CPA's Anthropic-compatible API, and with a management key the plugin also reads the Claude credential's five-hour and weekly usage, its **reset cards** (the free resets in Claude Settings > Usage) and model reasoning levels. No extra shim is required. CPA handles OAuth sign-in, token refresh and upstream credential selection.

Other providers' models served by CPA are still discovered and forwarded. Codex quota is a community contribution tested in the PR author's environment; this project has only run mock tests. Other non-Claude capabilities are unverified. If you need another provider, contributions and forks are welcome; see [Scope, contributing and forks](#scope-contributing-and-forks).

The Claude path has been verified with Magpie 0.1.2790 / 0.1.2826 and CPA 8.0.51. Reset-card display has only been tested with mocks so far.

The plugin bundles the [router-for-me](https://github.com/router-for-me) organization avatar as its shared icon, resized to 128×128 and embedded in metadata so displaying it needs no extra network request.

## Install and sign in

You need a working CPA backend, a business API key, and Magpie with provider plugin support. Magpie prepares Bun; the plugin has no external runtime dependencies.

```sh
magpie plugin add https://github.com/zhdsmy/magpie-cliproxyapi-plugin
magpie plugin login cpa
```

Distributed through GitHub only, with no npm package. For development, use `magpie plugin add /absolute/path/to/magpie-cliproxyapi-plugin` to install a local directory.

After signing in while Magpie is running, run `magpie plugin on <installed package or path>` (for local development, `magpie plugin on /absolute/path/to/magpie-cliproxyapi-plugin`), or restart Magpie, to activate the new account.

| Field | Meaning |
| --- | --- |
| CPA Base URL | Required, e.g. `https://cpa.example.invalid`. A trailing `/v1` is removed. URL userinfo, query strings and fragments are rejected. |
| Business API key | Required password input for the CPA business key, used for model discovery and inference. The plugin trims surrounding whitespace and returns it to Magpie. |
| Management key | Optional password input for quota and Claude reasoning levels. Inference works without it; the plugin makes no management requests and shows no reasoning levels. |
| Management URL | Optional **complete management endpoint**, e.g. `http://127.0.0.1:8317/v8/management`. Defaults to `<CPA Base URL>/v8/management`. |
| CPA credential | Optional exact CPA credential `name` or `auth_index`. |

The plugin's sign-in prompts collect the business key. Newer Magpie (source checked at v0.1.4139) does not ask for a separate key. Older versions (source checked at v0.1.2738 and v0.1.3431) may ask again; the key collected by the plugin takes precedence.

Business and management keys are used separately but stored together in Magpie's `plugin-auth.json`, with mode 0600. The plugin does not read CPA OAuth files.

The plugin's returned metadata does not contain the business key. Older hosts also copy sign-in answers into `metadata.businessKey` in the same file; newer hosts do not copy password answers.

Models are named `cpa/<CPA model ID>`, such as `cpa/claude-sonnet-4-6`. Upstream IDs are preserved. The plugin forwards Messages, SSE, tool round trips and count_tokens through CPA's Anthropic-compatible API. Discovery reads original IDs from the OpenAI-format list and names from the Anthropic-format list in parallel, regardless of the credential mix. It excludes cloaking-encoded IDs starting with `claude-fable-5-dd-`. Magpie's model selection and allowlist control actual exposure. Non-Claude inference also uses the Anthropic API and has not been verified by this project; the plugin does not switch models to Responses.

If a custom provider already owns `cpa`, Magpie changes the plugin's **effective ID** to `cpa-plugin`, producing `cpa-plugin/<ID>`. Check `magpie providers`, `magpie models`, or the gateway model catalog. `magpie plugin --json` may still show the self-reported ID `cpa`.

## Management access and quotas

The management key grants **full CPA management access, not read-only quota access**. The plugin sends it only as a Bearer header to the configured management endpoint and rejects redirects. It is never sent to business endpoints or directly to Anthropic / ChatGPT. Use only trusted endpoints and transport.

CPA considers only client addresses `127.0.0.1` and `::1` local. Normally Magpie and CPA must share a network namespace and use loopback. Otherwise, enable CPA `allow-remote` yourself. We recommend restricting sources with a firewall, tunnel or private network. Different Docker containers on one host, private addresses and Tailscale addresses normally count as remote. The plugin does not change these settings. **Exposing management to the public internet is discouraged.**

Quota belongs to the selected upstream **credential account**, rather than a model or the entire CPA credential pool. Adapters are selected by the credential's `provider` field. Both `claude` and `codex` are supported. Claude keeps `5 hours` / `7 days`; Codex names windows by duration, such as `5 hours` / `7 days` / `30 days`. Windows report used percentages, spans and reset times, without monetary values or emails. The management API also supplies model reasoning levels for the Claude channel; models with non-empty definitions are marked as reasoning and expose those levels. The level request is `GET <management base>/routing/model-definitions/claude`. If a reverse-proxy allowlist fronts the management API, allow this path or levels will not appear. If the management API is unreachable, returns an error or no management key is configured, model discovery still succeeds without levels. Discovery alone does not imply quota or reasoning-level support.

| Credential selection | Behavior |
| --- | --- |
| Unspecified, no enabled supported credential | An unsupported-quota or no-enabled-credential error; no windows. |
| Unspecified, exactly one enabled supported credential | Automatically selected. Windows participate in routing only if it is the sole enabled credential overall; otherwise they are display-only. |
| Unspecified, several enabled supported credentials | Show every supported credential, all marked `aside`; the same rule applies to pure Claude, pure Codex and mixed pools. |
| Explicit, uniquely matched supported credential | Query that account. With several enabled credentials, all windows are labeled and marked `aside`: **display only, excluded from routing**. |
| Explicit credential whose provider has no adapter | Only an unsupported-quota error. No upstream quota call and no fallback to Claude. |
| Missing, disabled or ambiguous selection | Error; no fallback to another credential. |

The total enabled count includes providers without quota support. Even when only one can be queried, CPA may use a different credential for inference, so a multi-credential pool remains display-only.

Multi-credential window names are `<window> (<Claude|Codex> <label>)`, sorted by provider and label. Use `label` when present; if empty or containing `@` or control characters, use the first 8 characters of the opaque `auth_index`. Never use `name`, which often contains an email. Explicit selections use the same labels.

At most two credential reads run concurrently for one management endpoint and key, within each call's shared 15-second budget. A failed credential gets a labeled text-only `aside` row while the others remain visible; only total failure returns an overall error. Management 401/403 always stops the whole read. Already-started parallel requests may finish, but queued requests do not start. Multiple credentials never show or combine reset cards.

Use `magpie quota --json` to inspect readings. Magpie omits `aside` from report JSON; its absence does not mean multi-credential windows participate in routing.

### Codex quota

Active reads send `GET https://chatgpt.com/backend-api/wham/usage` through CPA's management `api-call`, with `$TOKEN$` as the credential placeholder. When `/credentials` returns `id_token.chatgpt_account_id`, send it as `Chatgpt-Account-Id`; otherwise omit it without guessing the workspace.

Only `rate_limit.primary_window` / `secondary_window` are parsed. Invalid windows are skipped; no valid window is an error. With a single credential, an allowlisted plan type is returned in usage `plan`, never in window names. Complete, unexpired primary and secondary `x-codex-*` signals observed by CPA within 5 minutes supply the windows without an active ChatGPT request. Relative resets start at CPA's observation time. Both active and passive paths have only been tested with mocks here.

`additional_rate_limits`, Codex reset cards, credits and subscription expiry are omitted. Community testing does not replace this project's acceptance against real CPA / ChatGPT.

### Claude reset cards

The quota request is `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`, sent through CPA's management `api-call`. One response carries both the windows and the `cedar_ember` reset-card inventory, so no request is added. The result uses Magpie's native `resets` field: the account card shows "↺ N resets", with the soonest and per-card expiry on hover. No extra setup is needed.

- The plugin is **read-only**. It never calls `POST /api/organizations/{org}/reset_rate_limits`, `/api/oauth/profile` or CPA's cooldown reset, so it never spends a card. Magpie offers "Use a reset" only for its built-in Codex accounts; a plugin account's cards are display-only. Spend them from the Claude quota card in the CPA management center.
- The count is the sum of each grant's `resets_left`, skipping expired grants. `type` `session` / `weekly` is shown as a five-hour / weekly reset. Grants that cannot be used now (`eligible: false`, paused, or requiring a hit limit) still count as held; the CPA management center decides whether one can be spent.
- As in the CPA management center, one malformed grant hides the whole block, so a partial list is never shown as the full count. Windows are unaffected. Grant IDs and labels are not returned to the host.
- If upstream answers the query with 400/403, the plain usage request is read once instead, showing windows only. For the next 24 hours that credential sends the plain request directly instead of paying two requests each time. Other statuses are not retried.
- Eligibility is decided by Anthropic and may depend on the request UA (fixed `claude-cli/2.1.280`); Anthropic changes may require a plugin update.

### Fewer Anthropic requests

Anthropic rate-limits `oauth/usage` hard. The plugin keeps requests down as follows:

- **Cached and shared per upstream credential.** Readings are cached for 300 seconds per CPA credential (`auth_index`). Magpie accounts that select the same credential (left blank, by name or by `auth_index`) share one reading, one in-flight request and one backoff. Accounts on the same CPA that refresh together share one `/credentials` list for 15 seconds.
- **CPA's own data first.** CPA records the `anthropic-ratelimit-unified-*` headers of each real inference response in the credential's `quota.signals`, which the `/credentials` list the plugin already reads returns. When that record is at most 5 minutes old and has complete, unexpired `5h` and `7d` utilization and reset values, the plugin shows the windows from it without asking Anthropic. The reset-card inventory is then re-read only every 30 minutes, and cards that expire in between are dropped at display time; after a card is spent in the CPA management center, the count can lag by up to 30 minutes. A CPA version without this field, or a credential with no recent inference, is read as before. This path follows the CPA source and is so far covered by mock tests only.
- **Upstream rate limits respected.** An inner 429 with `Retry-After` waits that long; repeated failures back off from 300 seconds, doubling up to one hour. No Anthropic request is sent during backoff; recent CPA records still supply the windows.

## Authentication failures and recovery

CPA bans a source IP for 30 minutes after five management authentication failures, including loopback. After management HTTP 401/403 (including the reasoning-level read during model discovery), the plugin stops automatic requests for that endpoint and key. Changing only the credential selection does not unblock it. Quota errors do not invalidate business inference or the account's sign-in state.

Fix the management key and remote access settings first. Then sign in with a different management key or endpoint, or restart the Magpie plugin host after fixing the configuration. **Fixing CPA settings and signing in again with the same key and endpoint does not clear the running process's blocked state.** The state lives only in the plugin process; a new CLI process or restart can try again, so avoid repeatedly starting queries with a bad key.

Temporary management failures back off for 300 seconds; upstream backoff is described above. Successful readings are cached for 300 seconds and concurrent calls share one read. The plugin reuses readings for at most 900 seconds and never substitutes zero for missing or erroneous quota. The complete management read has a 15-second deadline.

## Host behavior and limits

- The plugin adds no inference retries. Magpie retries ordinary 429 responses on the same CPA account: about **8 attempts over 37 seconds** in isolated testing. Behavior depends on the host version and response.
- Magpie 0.1.2738 sends business User-Agent `magpie/0.1.2738` to CPA. The host treats the plugin as an account: the official `magpie provider set cpa user-agent=agent` command is rejected and the GUI does not offer the option. No client UA forwarding method is verified for this version. CPA treats it as a non-Claude-Code client and may rewrite requests according to the credential's cloak configuration. If pass-through behavior is required, explicitly configure and verify the credential's cloak mode using CPA documentation. The plugin neither changes it automatically nor spoofs the Claude CLI UA.
- The Claude OAuth usage request inside management api-call uses fixed UA `claude-cli/2.1.280 (external, cli)` and a beta header. Anthropic changes may require a plugin update.
- Magpie caches quota cards for about one minute. Repeated immediate reads may not call the plugin; the GUI card refresh button forces a new read.
- Magpie saves good readings to disk and may show them again during temporary errors, labeled `asOf`, including after a restart. **The plugin's 900-second limit does not bound host retention.** Check the reading time.
- Quota adapters support Claude and Codex. Model-specific windows such as Opus/Sonnet limits are omitted, and one credential's quota is not treated as pool quota.
- Tools, thinking, prompt caching and token counting for non-Claude models depend on CPA's conversion and the actual backend. Verify them yourself; successful discovery does not validate these capabilities.
- There is no OAuth sign-in, token refresh, model rewriting or custom failover. Same-model count_tokens failover and recovery depend on the host and have not been accepted.
- In Magpie 0.1.2790, plugin accounts did not produce `last` / `lastServedAt` in quota reports. External tools should not use these fields to identify the current account.

## Change settings and uninstall

Run `magpie plugin login cpa` again to change addresses or keys. Magpie identifies accounts by `cpa@host:port`: only one account is kept per host:port, even for different URL paths. Signing in again replaces it.

These commands were checked against the Magpie 0.1.2738 CLI:

```sh
magpie plugin logout cpa       # Forget the plugin sign-in
magpie plugin                 # Find the installed plugin name
magpie plugin rm '<installed-plugin-name>'
```

Update clients and model groups that use `cpa/` or `cpa-plugin/` before removal. Signing out or removing the plugin does not revoke keys at CPA.

## Scope, contributing and forks

The maintainer primarily uses and verifies Claude via CLIProxyAPI. Codex quota is a community contribution covered only by mock tests here; other provider features still depend on community contributions. Issues and pull requests are welcome, and so are forks that take the plugin in another direction under the MIT license.

Pull requests should keep the plugin's rules:

- No runtime dependencies. The management key goes only to the management endpoint; no emails or ChatGPT account IDs are returned to the host; display labels follow the rules above.
- No added retries, sign-in or OAuth refresh. Missing or invalid readings are errors, never zero.
- Cover new behavior with mock tests using fictional keys and responses (`npm test`), and state what was verified against a real CPA.

To add a quota adapter for another provider:

1. Add an entry to `usageAdapters` in `index.mjs`, keyed by the exact `files[].provider` value from CPA `/credentials`.
2. Implement `read(apiCall, credential, { now, memo })`. `memo` is an object kept per credential for long-lived upstream state. Each `apiCall({ method, url, header })` sends one inner request through CPA's management api-call; use `$TOKEN$` for the upstream credential, which CPA substitutes. The shared flow adds `auth_index`, and non-200 inner statuses throw.
3. Return `{ windows, resets?, plan? }` in Magpie's usage shape, e.g. `{ name: "5 hours", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" }`, where `used` is the percentage used and `span` is in seconds. Throw when no valid reading exists. Optionally implement `passive(credential, now)`, which derives `{ windows, observedAt }` from credential data CPA already returned, without an upstream request, and returns `undefined` when no reliable data exists. Adapters without reset inventories can return `inventory: false` so complete passive signals skip the active read.
4. Shared management authentication, the 15-second budget, size limits, rejection blocking, per-credential shared caching, single-flight reads, backoff and multi-credential `aside` labels apply automatically.

An unspecified selection reads all enabled supported credentials. A new adapter adds windows to mixed pools, but only a sole enabled credential participates in routing.

## Development and acknowledgment

```sh
npm test
```

Tests use fictional keys and local mocks; no real account is required. Isolated official-host integration is separate evidence and does not replace real CPA acceptance.

The MIT project [sub2api-magpie-plugin](https://github.com/FischelChern/sub2api-magpie-plugin) informed the Magpie integration approach. This plugin's runtime was implemented independently without copying its code. See [LICENSE](LICENSE) for the MIT license.
