# NodeCoda MCP Workflow Build Contract

The public service exposes one asynchronous outcome: build a specific NodeCoda Source revision for an explicit Build Target.

## Build

Call `build_dify_workflow` with all fields present:

```json
{
  "source": "@language nodecoda/1\n@mode workflow\nfunction main(string query) -> string { return query; }\n",
  "source_filename": "demo.ncoda",
  "language_identity": "nodecoda/1",
  "target_profile": "dify-1.16-graphon-0.6",
  "idempotency_key": "demo-build-1"
}
```

> **Transport requirement (live gateway, verified 2026-08-14):** the gateway
> requires the `Idempotency-Key` HTTP header to **echo** the body
> `idempotency_key` — sending it in only one place is rejected with
> `400 WORKFLOW_BUILD_REQUEST_INVALID`. The MCP servers in this repo
> (`mcp-stdio-server.mjs`, `mcp-http-server.mjs`) already forward both, so MCP
> callers need to do nothing extra; **direct REST callers must set both** (see
> `references/public-service.md` for the curl form).

A successful admission returns `QUEUED`, a `build_id`, the selected identity fields, and `poll_after_ms`. An unavailable admission returns `availability=UNAVAILABLE`, a `failure_kind`, and sometimes `retry_after_seconds`; it does not return a usable Build identity.

### Guest admission statuses (try.nodecoda.com, no key)

On the free-try instance the admission answer is a **structured JSON status**
(HTTP 200, inside `data`) — not a hard error, unless the global budget is
exhausted (then HTTP 429 `GUEST_QUOTA_EXHAUSTED`):

| status | fields | meaning / handling |
|---|---|---|
| `queued` | `build_id`, `poll_after_ms`, `quota { mode, success, success_used, diagnostic, resets_in_seconds, register_hint }` | admitted; poll per `poll_after_ms` (server paces it to 2000 ms when ≥80% of the daily cap is used). `quota.success_used` is the low-key "used N times" counter; never render remaining/countdown/scarcity copy. |
| `throttled` | `reason` (`device_rate` / `ip_quota`), `retry_after_ms`, `quota` | transient rate tier; no `build_id`. Client sleeps `retry_after_ms` and replays the **same** submission (same idempotency key — a throttled admission created no build), bounded ≤3. The MCP servers in this repo do this automatically and annotate the final still-throttled payload with `_client_retries` (client-side field, never sent by the gateway). |
| `exhausted` | `code=GUEST_QUOTA_EXHAUSTED`, `message`, `quota`, `register_hint` | device daily quota soft stop (**NOT an error**, do not retry). Render `message` (server-authored gentle copy) + used count; append registration copy only when `register_hint: true`. |

`exhausted` is passed through untouched — it is a product state, not a failure.

> Live gateway note (verified 2026-08-12): the public gateway wraps every
> response as `{ "code": 0, "message": "...", "data": { ... } }`. The MCP
> servers in this repo (`mcp-stdio-server.mjs`, `mcp-http-server.mjs`) unwrap
> `data` before returning tool results, so the shapes below are what the agent
> actually receives. Error responses without a `data` key pass through as-is.

The same idempotency key is valid only for an exact replay. Any Source, filename, language identity, or target profile change requires a new key.

> **Header 要求（实证 2026-08-14）**：公网网关要求幂等 key **同时**出现在 body 的 `idempotency_key` 字段和 `Idempotency-Key` 请求头中；只放 body 直连 REST 会返回 `400 WORKFLOW_BUILD_REQUEST_INVALID`。MCP server 已自动双份转发，REST 直连必须自己带 header。

## Poll

Call `get_workflow_build`:

```json
{
  "build_id": "build_example"
}
```

Continue polling `QUEUED`, `BUILDING`, or `CANCELLING`. Terminal states are `SUCCEEDED`, `FAILED`, and `CANCELLED`. `availability=UNAVAILABLE` is also a stop condition unless bounded retry guidance is present.

A successful response contains an `artifact` with `media_type`, `sha256`, and `content`. The public gateway's poll response carries only artifact *metadata* (`artifact_sha256`, `artifact_size`, `artifact_media_type`, `artifact_available`) and serves the raw content at `GET /v1/workflow-builds/{build_id}/artifact`; the MCP servers fetch that endpoint best-effort on `SUCCEEDED` and attach it as `artifact.content` so the contract shape holds. Treat Source as the source of truth and the artifact as generated target-specific output.

> **REST 直连拉取 artifact**：直连 REST 时 poll 响应只带 metadata，内容需另行 `GET /v1/workflow-builds/{build_id}/artifact`（MCP server 会在 SUCCEEDED 时 best-effort 拉取并拼成 `artifact.content`，直连时无此便利）。

On `FAILED`, use `failure_kind` and structured `diagnostics`. Repair Source only for deterministic Source diagnostics. Target, policy, timeout, service, or data-integrity failures are not evidence for a Source edit.

## Cancel

Call `cancel_workflow_build` once after the overall polling deadline:

```json
{
  "build_id": "build_example"
}
```

Cancellation may return `CANCELLED`, `CANCELLING`, an already-terminal state, or `availability=UNAVAILABLE`. Continue bounded observation for at most 35 seconds after requesting cancellation.

## Invariants

- Source filename ends in `.ncoda`.
- Source and request identity are both `nodecoda/1`.
- Target profile is explicit and must match the returned Build.
- Public identity is always `build_id`.
- No generic operation selector exists.
- No implementation package, service code, or internal execution state is part of this contract.
