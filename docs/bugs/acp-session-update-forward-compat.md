# Resolved: unknown ACP `session/update` variants are preserved

## Status

The v1 bridge already preserves unknown updates on master `163850b` (0.2.4). The
previous version of this report described the SDK's default behavior but
incorrectly presented it as the current behavior of `acp-mcp`.

Verified with Deno 2.9.6 and the pinned `@agentclientprotocol/sdk` 1.7.0 using
both `SessionManager` and MCP `tools/call`, with raw JSON-RPC emitted by
`tests/fixtures/raw_wire_acp_agent.ts`.

## Implementation

The SDK's normal `session/update` router validates known update tags before
calling registered notification handlers. A custom `onNotification` handler
alone does not bypass that validation.

`V1Driver` instead wraps the SDK stream with `interceptSessionUpdates` from
`src/acp/session_update_stream.ts`. The interceptor consumes update
notifications before the SDK router and passes the original params to the
bridge. The SDK continues to handle other messages, including request
correlation and prompt responses. No additional SDK workaround is needed.

## Verified behavior

The raw-wire fixture emits a known message chunk, an unknown update, and another
known message chunk. The unknown notification contains:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "<active ACP session ID>",
    "update": {
      "sessionUpdate": "future_update",
      "detail": { "retained": true }
    },
    "_meta": { "fixture": "raw-wire", "ordinal": 2 },
    "ordinal": 2
  }
}
```

The existing session-flow regression confirms that:

- journal events retain arrival order and the unknown `future_update` kind;
- raw params, unknown fields, and `_meta` remain in the journal and survive MCP
  `get_events(includeRaw: true)` unchanged;
- the final text is `raw reply` and the prompt completes with `end_turn`;
- a second prompt completes using the same runtime and downstream ACP session;
- mutating a returned manager snapshot does not change the journal.

A separate native MCP stdio smoke check on 14 October 2026 also verified
successful prompt completion and a second prompt in the same ACP session.

Run the focused regression with:

```sh
deno test --allow-env --allow-read --allow-run --allow-write --filter unknown tests/session_flow_test.ts
```

These checks establish v1 forwarding behavior. They do not establish provider
authentication, real-agent compatibility, or support for every future ACP
protocol change. Notifications without a string `sessionId` cannot be routed and
are consumed with a diagnostic.
