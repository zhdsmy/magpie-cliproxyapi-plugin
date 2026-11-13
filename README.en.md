# magpie-cliproxyapi-plugin

[中文](README.md)

Connect CLIProxyAPI (CPA) models to Magpie, with optional credential quota and Claude reasoning-level queries through CPA's management API. Quota adapters support Claude and Codex (ChatGPT) credentials. No extra shim is required. CPA handles OAuth sign-in, token refresh, and upstream credential selection.

The Claude path has been verified with Magpie 0.1.2790 / 0.1.2826 and CPA 8.0.51. The multi-provider extension has only been tested with mocks. Verify actual capabilities of non-Claude backends yourself.

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
| Management key | Optional password input for quota and Claude reasoning levels. Inference works without it; the plugin makes no management requests and shows no reasoning levels. |
| Management URL | Optional **complete management endpoint**, e.g. `http://127.0.0.1:8317/v8/management`. Defaults to `<CPA Base URL>/v8/management`. |
| CPA credential | Optional exact CPA credential `name` or `auth_index`. |
| Business API key | The required CPA business key in the plugin form, returned by authorize to the host, used for model discovery and inference. |

Business and management keys are used separately but stored together in Magpie's `plugin-auth.json`, with mode 0600. The plugin does not read CPA OAuth files.

Models are named `cpa/<CPA model ID>`, such as `cpa/claude-sonnet-4-6`. Upstream IDs are preserved. The plugin forwards Messages, SSE, tool round trips and count_tokens through CPA's Anthropic-compatible API. Discovery keeps all valid model IDs except cloaking-encoded IDs starting with `claude-fable-5-dd-`. Magpie's model selection and allowlist control actual exposure.

If a custom provider already owns `cpa`, Magpie changes the plugin's **effective ID** to `cpa-plugin`, producing `cpa-plugin/<ID>`. Check `magpie providers`, `magpie models`, or the gateway model catalog. `magpie plugin --json` may still show the self-reported ID `cpa`.

## Management access and quotas

The management key grants **full CPA management access, not read-only quota access**. The plugin sends it only as a Bearer header to the configured management endpoint and rejects redirects. It is never sent to business endpoints or directly to Anthropic. Use only trusted endpoints and transport.

CPA considers only client addresses `127.0.0.1` and `::1` local. Normally Magpie and CPA must share a network namespace and use loopback. Otherwise, enable CPA `allow-remote` yourself. We recommend restricting sources with a firewall, tunnel or private network. Different Docker containers on one host, private addresses and Tailscale addresses normally count as remote. The plugin does not change these settings. **Exposing management to the public internet is discouraged.**

Quota belongs to the selected upstream **credential account**, rather than a model or the entire CPA credential pool. Adapters are selected by the credential's `provider` field. Both `claude` and `codex` report usage percentages, spans and reset times, without monetary values or account details. The management API also supplies model reasoning levels for the Claude channel; models with non-empty definitions are marked as reasoning and expose those levels. The level request is `GET <management base>/routing/model-definitions/claude`. If a reverse-proxy allowlist fronts the management API, allow this path or levels will not appear. If the management API is unreachable, returns an error or no management key is configured, model discovery still succeeds without levels. Discovering non-Claude models does not imply quota or reasoning-level support.

| Credential selection | Behavior |
| --- | --- |
| Unspecified, no enabled supported credential | An unsupported-quota or no-enabled-credential error; no windows. |
| Unspecified, exactly one enabled supported credential | Automatically selected. Windows participate in routing only if it is the sole enabled credential overall; otherwise they are display-only. |
| Unspecified, several enabled supported credentials | When Codex is present and all supported credentials are Claude / Codex, query sequentially and display all as aside. Other pools still require selection. |
| Explicit, uniquely matched supported credential | Query that account. With several enabled credentials, all windows are labeled and marked `aside`: **display only, excluded from routing**. |
| Explicit credential whose provider has no adapter | Only an unsupported-quota error. No upstream quota call and no fallback to Claude. |
| Missing, disabled or ambiguous selection | Error; no fallback to another credential. |

The total enabled count includes providers without quota support. Even when only one can be queried, CPA may use a different credential for inference, so a multi-credential pool remains display-only.

Use `magpie quota --json` to inspect readings. Magpie omits `aside` from report JSON; its absence does not mean multi-credential windows participate in routing.



Codex uses management api-call to read primary / secondary windows from `https://chatgpt.com/backend-api/wham/usage`. Labels include `Codex/Plus/5h/#2` and `Codex/Free/30d/#1`, with Plus before Free. Numbers follow auth_index order and may change when credentials change. Claude labels become `Claude/5h` and `Claude/7d`; its request and percentage parsing stay unchanged. Percentages across accounts or periods are never summed or averaged; model access and emails are not displayed. All credentials share the 15-second budget; any failure applies the existing cache and backoff policy to the whole group.

When a non-empty Anthropic-format catalog contains only cloaking-encoded IDs, one additional OpenAI-format catalog request preserves its original IDs. Ordinary and valid empty catalogs do not trigger this fallback.

## Authentication failures and recovery

CPA bans a source IP for 30 minutes after five management authentication failures, including loopback. After management HTTP 401/403, the plugin stops automatic requests for that endpoint and key. Changing only the credential selection does not unblock it. Quota errors do not invalidate business inference or the account's sign-in state.

Fix the management key and remote access settings first. Then sign in with a different management key or endpoint, or restart the Magpie plugin host after fixing the configuration. **Fixing CPA settings and signing in again with the same key and endpoint does not clear the running process's blocked state.** The state lives only in the plugin process; a new CLI process or restart can try again, so avoid repeatedly starting queries with a bad key.

Other temporary failures back off for 300 seconds. Successful readings are cached for 300 seconds and concurrent calls share one management read. The plugin reuses readings for at most 900 seconds and never substitutes zero for missing or erroneous quota. The complete management read has a 15-second deadline.

## Host behavior and limits

- The plugin adds no inference retries. Magpie retries ordinary 429 responses on the same CPA account: about **8 attempts over 37 seconds** in isolated testing. Behavior depends on the host version and response.
- Magpie 0.1.2738 sends business User-Agent `magpie/0.1.2738` to CPA. The host treats the plugin as an account: the official `magpie provider set cpa user-agent=agent` command is rejected and the GUI does not offer the option. No client UA forwarding method is verified for this version. CPA treats it as a non-Claude-Code client and may rewrite requests according to the credential's cloak configuration. If pass-through behavior is required, explicitly configure and verify the credential's cloak mode using CPA documentation. The plugin neither changes it automatically nor spoofs the Claude CLI UA.
- The OAuth usage request inside management api-call uses fixed UA `claude-cli/2.1.280 (external, cli)` and a beta header. Anthropic changes may require a plugin update.
- Magpie caches quota cards for about one minute. Repeated immediate reads may not call the plugin; the GUI card refresh button forces a new read.
- Magpie saves good readings to disk and may show them again during temporary errors, labeled `asOf`, including after a restart. **The plugin's 900-second limit does not bound host retention.** Check the reading time.
- Claude model-specific windows such as Opus/Sonnet limits are omitted, and one credential's quota is not treated as pool quota.
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

## Adding a provider

1. Add an entry to `usageAdapters` in `index.mjs`, keyed by the exact `files[].provider` value returned by CPA `/credentials`. The first entry is `claude`. No new login fields, subplugins or dependencies are needed.
2. Supply the inner CPA management api-call `method`, `url` and `header` template in `request`. Use `$TOKEN$` for the upstream credential, which CPA substitutes. The shared flow adds `auth_index`; the management key must not enter this template.
3. `parse(body)` receives successful inner-response JSON and returns native windows, such as `{ name: "Window", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" }`. `used` is the percentage used and `span` is in seconds. Return only verified fields; throw when no valid reading exists, rather than filling in zero or exposing account details.
4. Reuse shared management authentication, the 15-second budget, response-size limits, rejection blocking, caching, single-flight requests, backoff and multi-credential `aside` rules. Adapters must not add retries, sign-in or OAuth refresh.
5. Add mock cases with fictional responses and keys in `test/`, covering the template, parser, selection and failures, then run `npm test`. Verify the new provider's actual business capabilities separately.

## Development and acknowledgment

```sh
npm test
```

Tests use fictional keys and local mocks; no real account is required. There are currently 46 explicit tests. Isolated official-host integration is separate evidence and does not replace real CPA acceptance.

The MIT project [sub2api-magpie-plugin](https://github.com/FischelChern/sub2api-magpie-plugin) informed the Magpie integration approach. This plugin's runtime was implemented independently without copying its code. See [LICENSE](LICENSE) for the MIT license.
