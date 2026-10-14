import { deepStrictEqual } from "node:assert/strict";
import {
  DEFAULT_MAX_MANAGED_SESSIONS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  SessionManager,
} from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function fakeFixturePath() {
  const path =
    new URL("./fixtures/fake_acp_agent.ts", import.meta.url).pathname;
  return Deno.build.os === "windows"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

Deno.test("requested cwd is shared by the ACP session and child process", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "acp-mcp-requested-cwd-" });
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: ["run", "--allow-read", fakeFixturePath(), "--report-cwd"],
    },
  });
  try {
    const session = await manager.start("fake", cwd);
    const report = JSON.parse(
      String(
        session.configOptions.find((option) => option.id === "cwd-report")
          ?.currentValue,
      ),
    ) as { processCwd: string; sessionCwd: string };
    const requestedRealPath = await Deno.realPath(cwd);
    if (
      await Deno.realPath(report.processCwd) !== requestedRealPath ||
      await Deno.realPath(report.sessionCwd) !== requestedRealPath
    ) {
      throw new Error(
        `Requested cwd diverged: ${JSON.stringify(report)}`,
      );
    }
  } finally {
    await manager.closeAll();
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("session query APIs return detached snapshots", async () => {
  const manager = rawFixtureManager();
  try {
    const session = await manager.start("raw", Deno.cwd());
    const snapshot = manager.getSessionSnapshot(session.id);
    const listed = manager.listSessionSnapshots();
    (snapshot.configOptions as Array<Record<string, unknown>>).push({
      id: "caller-mutation",
    });
    (listed[0].capabilities as Record<string, unknown>).callerMutation = true;
    if (
      manager.getSessionSnapshot(session.id).configOptions.some((option) =>
        option.id === "caller-mutation"
      ) ||
      "callerMutation" in
        (manager.getSessionSnapshot(session.id).capabilities as object)
    ) {
      throw new Error("A caller mutation changed manager-owned session state");
    }
    if (manager.sessionCount !== 1 || !manager.hasSession(session.id)) {
      throw new Error("Read-only session queries changed manager capacity");
    }
  } finally {
    await manager.closeAll();
  }
});

function rawFixtureManager() {
  return new SessionManager({
    raw: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "tests/fixtures/raw_wire_acp_agent.ts",
      ],
    },
  });
}

Deno.test("journals unknown raw updates in order and keeps the connection usable", async () => {
  const manager = rawFixtureManager();
  const server = createMcpServer({}, manager);
  const mcp = await connectMcp(server);
  try {
    const session = await manager.start("raw", Deno.cwd());
    const response = await manager.prompt(session.id, "raw wire");
    if (response.text !== "raw reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    const events = manager.getEvents(session.id).events;
    if (events.length !== 3) {
      throw new Error(`Expected three routed updates, got ${events.length}`);
    }
    if (
      events.map((event) => event.kind).join(",") !==
        "agent_message_chunk,future_update,agent_message_chunk"
    ) {
      throw new Error("Raw updates were not journaled in arrival order");
    }
    if (
      (events[1].update as { detail?: { retained?: boolean } }).detail
        ?.retained !== true
    ) {
      throw new Error("Unknown update details were not retained");
    }
    const raw = events[1].raw;
    if (
      JSON.stringify(raw) !== JSON.stringify({
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: "future_update",
          detail: { retained: true },
        },
        _meta: { fixture: "raw-wire", ordinal: 2 },
        ordinal: 2,
      })
    ) {
      throw new Error(
        "Original raw params, unknown detail, or metadata changed",
      );
    }
    const replay = parseToolResult(
      await mcp.callTool("get_events", {
        sessionId: session.id,
        includeRaw: true,
      }).response,
    );
    deepStrictEqual(
      replay.events,
      events,
      "MCP changed journal contents, update order, or raw metadata",
    );
    (events[1].update as { detail: { retained: boolean } }).detail.retained =
      false;
    const reread = manager.getEvents(session.id).events[1].update as {
      detail: { retained: boolean };
    };
    if (!reread.detail.retained) {
      throw new Error("Mutating an event query changed the manager journal");
    }
    const followup = await manager.prompt(session.id, "followup");
    if (followup.text !== "raw reply" || followup.stopReason !== "end_turn") {
      throw new Error(
        "Unknown update disrupted the next prompt in the same session",
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("routes raw updates to each managed session", async () => {
  const manager = rawFixtureManager();
  try {
    const [first, second] = await Promise.all([
      manager.start("raw", Deno.cwd()),
      manager.start("raw", Deno.cwd()),
    ]);
    await Promise.all([
      manager.prompt(first.id, "first"),
      manager.prompt(second.id, "second"),
    ]);
    for (const session of [first, second]) {
      const events = manager.getEvents(session.id).events;
      if (
        events.length !== 3 ||
        events.some((event) =>
          (event.raw as { sessionId: string }).sessionId !==
            session.acpSessionId
        )
      ) {
        throw new Error(
          `Updates were misrouted for session ${session.acpSessionId}`,
        );
      }
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("starts a fake ACP agent and returns streamed prompt text", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const response = await manager.prompt(session.id, "hello");
    if (response.text !== "fake reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    if (response.stopReason !== "end_turn") {
      throw new Error(`Unexpected stop reason: ${response.stopReason}`);
    }
    const journal = manager.getEvents(session.id);
    if (
      journal.events.length !== 1 ||
      journal.events[0].kind !== "agent_message_chunk"
    ) throw new Error("Expected one normalized text event");
    if (!journal.events[0].raw) {
      throw new Error("Expected original ACP notification to be retained");
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("polls and cancels an asynchronous prompt", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    const pending = await manager.waitPrompt(session.id, prompt.id, 0);
    if (pending.state !== "running") {
      throw new Error(`Expected running prompt, got ${pending.state}`);
    }
    const cancelled = await manager.cancelPrompt(session.id, prompt.id);
    if (cancelled.state !== "cancelled") {
      throw new Error(`Expected cancelled prompt, got ${cancelled.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("cancellation remains authoritative if the prompt then errors", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        fakeFixturePath(),
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "cancel then fail");
    const cancelled = await manager.cancelPrompt(session.id, prompt.id);
    await prompt.done;
    if (cancelled.state !== "cancelled" || prompt.state !== "cancelled") {
      throw new Error(
        `Prompt failure overwrote cancellation: ${prompt.state}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("late ACP output after cancellation is journaled but cannot complete the prompt", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: ["run", "--allow-env", "--allow-read", fakeFixturePath()],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "cancel then late update");
    await manager.cancelPrompt(session.id, prompt.id);
    await prompt.done;
    const journal = manager.getEvents(session.id);
    if (
      prompt.state !== "cancelled" || prompt.text ||
      !journal.events.some((event) => event.kind === "agent_message_chunk")
    ) {
      throw new Error(
        `Late output changed cancelled state: ${
          JSON.stringify({
            state: prompt.state,
            text: prompt.text,
            events: journal.events.map((event) => event.kind),
          })
        }`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("closing an active session cancels its prompt before cleanup", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        fakeFixturePath(),
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    await manager.close(session.id);
    await prompt.done;
    if (prompt.state !== "cancelled" || manager.sessionCount !== 0) {
      throw new Error(
        `Active close did not cancel/remove the session: ${prompt.state}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("cancelling after completed prompt preserves completion", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        fakeFixturePath(),
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "hello");
    await prompt.done;
    const result = await manager.cancelPrompt(session.id, prompt.id);
    if (result.state !== "completed" || result.stopReason !== "end_turn") {
      throw new Error(`Late cancellation rewrote completion: ${result.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("closed sessions release capacity while active sessions are retained", async () => {
  if (DEFAULT_MAX_MANAGED_SESSIONS !== 8) {
    throw new Error(
      `Production session capacity changed: ${DEFAULT_MAX_MANAGED_SESSIONS}`,
    );
  }
  const manager = new SessionManager(
    {
      fake: {
        command: Deno.execPath(),
        args: ["run", "--no-check", "tests/fixtures/raw_wire_acp_agent.ts"],
      },
    },
    undefined,
    undefined,
    2,
  );
  const sessionCount = () => manager.sessionCount;
  try {
    const first = await manager.start("fake", Deno.cwd());
    const second = await manager.start("fake", Deno.cwd());
    if (sessionCount() !== 2) {
      throw new Error("The test session capacity was not filled");
    }

    let rejected = false;
    try {
      await manager.start("missing-agent", Deno.cwd());
    } catch (error) {
      rejected = String(error).includes("Active session limit (2) reached");
    }
    if (!rejected || sessionCount() !== 2) {
      throw new Error(
        "Capacity was not rejected before agent lookup/startup",
      );
    }

    await manager.close(first.id);
    if (sessionCount() !== 1) {
      throw new Error("Closing a session did not release capacity");
    }
    const replacement = await manager.start("fake", Deno.cwd());
    if (sessionCount() !== 2) {
      throw new Error("A closed session continued to consume capacity");
    }
    await manager.close(replacement.id);
    await manager.close(second.id);
    if (sessionCount() !== 0) {
      throw new Error("Capacity test did not clean up all sessions");
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("a hung ACP session/close cannot block child cleanup", async () => {
  const manager = new SessionManager(
    {
      fake: {
        command: Deno.execPath(),
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          fakeFixturePath(),
          "--session-close-hang",
        ],
      },
    },
    DEFAULT_SESSION_START_TIMEOUT_MS,
    40,
  );
  try {
    const session = await manager.start("fake", Deno.cwd());
    const startedAt = performance.now();
    await manager.close(session.id);
    if (
      performance.now() - startedAt > 1_000 || manager.sessionCount !== 0
    ) {
      throw new Error("Hung session/close blocked cleanup or retained state");
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("holds operator permission until an advertised choice is resolved", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start(
      "fake",
      Deno.cwd(),
      {},
      undefined,
      "operator",
    );
    const prompt = manager.beginPrompt(session.id, "permission");
    for (
      let i = 0;
      i < 100 &&
      manager.getSessionSnapshot(session.id).pendingPermissions.length === 0;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending =
      manager.getSessionSnapshot(session.id).pendingPermissions[0];
    if (!pending) throw new Error("Permission request was not exposed");
    manager.resolvePermission(session.id, pending.id, "reject");
    await prompt.done;
    if (prompt.text !== "reject") {
      throw new Error(`Unexpected permission response text: ${prompt.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("loads a session when the fake agent advertises support", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.load("fake", "existing-session", Deno.cwd());
    if (session.acpSessionId !== "existing-session") {
      throw new Error("Loaded session ID was not retained");
    }
    const result = await manager.prompt(session.id, "hello");
    if (result.text !== "fake reply") {
      throw new Error(`Unexpected loaded session response: ${result.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("advertises and uses ACP boolean configuration options", async () => {
  const manager = new SessionManager({
    bool: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
        "--advertise-bool",
      ],
    },
  });
  try {
    const session = await manager.start("bool", Deno.cwd(), {
      "use-fast-mode": "true",
    });
    const fastMode = session.configOptions.find((option) =>
      option.id === "use-fast-mode"
    );
    if (fastMode?.currentValue !== true) {
      throw new Error("String config value was not sent as an ACP boolean");
    }
    const updated = await manager.setConfigOption(
      session.id,
      "use-fast-mode",
      "false",
    );
    if (
      updated.find((option) => option.id === "use-fast-mode")?.currentValue !==
        false
    ) {
      throw new Error("Interactive boolean config update did not reach ACP");
    }
  } finally {
    await manager.closeAll();
  }
});
