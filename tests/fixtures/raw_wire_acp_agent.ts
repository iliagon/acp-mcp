const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";

async function write(value: unknown) {
  const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    offset += await Deno.stdout.write(bytes.subarray(offset));
  }
}

async function handle(line: string) {
  let message: {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.method || message.id === undefined) return;
  let result: unknown = {};
  if (message.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {} };
  } else if (message.method === "session/new") {
    result = { sessionId: crypto.randomUUID() };
  } else if (message.method === "session/prompt") {
    const sessionId = message.params?.sessionId;
    const prompt =
      (message.params?.prompt as Array<{ text?: string }> | undefined)
        ?.map((part) => part.text ?? "").join("") ?? "";
    if (typeof sessionId === "string") {
      const raw = (
        sessionUpdate: unknown,
        extra: Record<string, unknown> = {},
      ) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: sessionUpdate,
          _meta: { fixture: "raw-wire", ordinal: extra.ordinal },
          ...extra,
        },
      });
      if (prompt === "event burst" || prompt === "oversized event") {
        const count = prompt === "event burst" ? 1005 : 1;
        for (let index = 1; index <= count; index++) {
          await write(raw({
            sessionUpdate: "future_update",
            detail: prompt === "oversized event"
              ? "x".repeat(4 * 1024 * 1024)
              : index,
          }, { ordinal: index }));
        }
      } else if (prompt === "delegate isolation") {
        const large = "INTERNAL_THOUGHT_MARKER " + "x".repeat(12000);
        const updates = [
          {
            sessionUpdate: "available_commands_update",
            availableCommands: [{
              name: "scan",
              description: "INTERNAL_TOOL_MARKER " + "y".repeat(8000),
            }],
          },
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: large },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "internal-call",
            title: "INTERNAL_TOOL_MARKER " + "z".repeat(8000),
            kind: "read",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "internal-call",
            content: [{
              type: "content",
              content: {
                type: "text",
                text: "TOOL_HISTORY_MARKER " + "q".repeat(8000),
              },
            }],
          },
          {
            sessionUpdate: "usage_update",
            size: { inputTokens: 654321, outputTokens: 123456 },
          },
          {
            sessionUpdate: "future_update",
            detail: {
              marker: "UNKNOWN_EVENT_MARKER",
              payload: "r".repeat(12000),
            },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Delegation " },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "complete." },
          },
        ];
        for (const [index, update] of updates.entries()) {
          await write(
            raw(update, {
              ordinal: index + 1,
              payloadMarker: `RAW_PARAMS_MARKER_${index + 1}`,
            }),
          );
        }
      } else {
        await write(raw({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "raw " },
        }, { ordinal: 1 }));
        await write(
          raw({ sessionUpdate: "future_update", detail: { retained: true } }, {
            ordinal: 2,
          }),
        );
        await write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "reply" },
            },
            _meta: { fixture: "raw-wire", ordinal: 3 },
          },
        });
      }
      await write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "unrouteable" } },
      });
    }
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/close") {
    result = {};
  }
  await write({ jsonrpc: "2.0", id: message.id, result });
}

const reader = Deno.stdin.readable.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    await handle(line);
  }
}
