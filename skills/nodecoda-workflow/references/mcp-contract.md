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

A successful admission returns `QUEUED`, a `build_id`, the selected identity fields, and `poll_after_ms`. An unavailable admission returns `availability=UNAVAILABLE`, a `failure_kind`, and sometimes `retry_after_seconds`; it does not return a usable Build identity.

> Live gateway note (verified 2026-08-12): the public gateway wraps every
> response as `{ "code": 0, "message": "...", "data": { ... } }`. The MCP
> servers in this repo (`mcp-stdio-server.mjs`, `mcp-http-server.mjs`) unwrap
> `data` before returning tool results, so the shapes below are what the agent
> actually receives. Error responses without a `data` key pass through as-is.

The same idempotency key is valid only for an exact replay. Any Source, filename, language identity, or target profile change requires a new key.

## Poll

Call `get_workflow_build`:

```json
{
  "build_id": "build_example"
}
```

Continue polling `QUEUED`, `BUILDING`, or `CANCELLING`. Terminal states are `SUCCEEDED`, `FAILED`, and `CANCELLED`. `availability=UNAVAILABLE` is also a stop condition unless bounded retry guidance is present.

A successful response contains an `artifact` with `media_type`, `sha256`, and `content`. The public gateway's poll response carries only artifact *metadata* (`artifact_sha256`, `artifact_size`, `artifact_media_type`, `artifact_available`) and serves the raw content at `GET /v1/workflow-builds/{build_id}/artifact`; the MCP servers fetch that endpoint best-effort on `SUCCEEDED` and attach it as `artifact.content` so the contract shape holds. Treat Source as the source of truth and the artifact as generated target-specific output.

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
