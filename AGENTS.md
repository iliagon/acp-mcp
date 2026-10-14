# Agent guide

## Purpose and layout

`acp-mcp` is a Deno/TypeScript MCP stdio server that controls downstream ACP
coding agents. The MCP host owns orchestration; downstream agents own models and
authentication. Start with `README.md` for tool contracts and configuration.

| Path                                         | Responsibility                                                   |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `src/main.ts`, `src/cli.ts`, `src/server.ts` | CLI, offline doctor, server startup/shutdown                     |
| `src/mcp/server.ts`                          | MCP tool schemas, handlers, delegation                           |
| `src/sessions/manager.ts`                    | Sessions, prompts, events, permissions, cancellation             |
| `src/acp/`                                   | Protocol interface, v1/v2 drivers, raw update interception       |
| `src/agents/`, `src/config/`, `src/models/`  | Agent profiles, trusted config discovery, model policy/discovery |
| `src/runtime/`, `src/workspaces/`            | Child processes, workspace snapshots/planning/cleanup            |
| `tests/`, `tests/fixtures/`                  | Behavior tests and deterministic ACP subprocesses                |
| `scripts/`, `.github/workflows/release.yml`  | Native builds, packaging, compatibility, releases                |

## Development

Deno **2.9.6** is pinned in `mise.toml`; dependencies are pinned in `deno.jsonc`
and `deno.lock`. Run from the repository root:

```sh
mise install
mise exec -- deno task check
mise exec -- deno task test tests
mise exec -- deno lint
mise exec -- deno fmt --check <changed-files>
mise exec -- deno task build
```

Without mise, use the pinned Deno directly. `task build` writes the native
binary to `dist/`; Deno is not required to run that binary. Explicit `tests`
avoids discovering generated pilot tests under ignored `dist/`. For
documentation-only changes, format the changed Markdown and run
`git diff --check`.

## Contracts to preserve

- Stdout carries MCP protocol messages; send diagnostics to stderr. Close child
  processes on session closure and host disconnection.
- Bridge session IDs and event journals are process-local. Downstream ACP
  session IDs are distinct; resume depends on the agent's advertised capability.
- Keep prompt completion, cancellation, permissions, and process exit distinct.
  Resolve permissions using an offered `optionId`; `read_only` is not an OS
  sandbox.
- Preserve unknown `session/update` payloads and metadata through the raw-update
  interception path. Test MCP serialization as well as manager output.
- Event pagination must handle filtered thoughts, journal eviction, and appends
  between pages without skipping unread events. Consume returned `nextSequence`
  even when the visible page is empty.
- Discover models/configuration from the live ACP advertisement. ACP v1 is the
  default; v2 is explicit and experimental. Do not silently switch protocols,
  models, or implementations after failure.
- `--config` loads only that file. Otherwise, home and ancestor `.acp-mcp.json`
  files merge toward the working directory; sessions capture config at creation.
  Executable definitions belong in trusted home/explicit config, not project
  config. Keep credentials out of repository files and logs.

## Tests and changes

- Extend existing scenarios before adding tests. Assert observable results with
  minimal, general cases; avoid private fields, mock call counts, and duplicated
  coverage. Use ACP subprocess fixtures for protocol behavior and real MCP
  transport when checking the public interface.
- Run the affected tests while iterating, then type-check, lint, and run the
  project suite for code changes. Build/test the native executable for runtime
  or packaging changes; opt-in native smoke uses `ACPMCP_NATIVE_EXECUTABLE`. Add
  new test files to the explicit `task check` list when needed. Keep paths and
  process handling portable across Windows x64, Linux x64, and macOS ARM64.
- Live compatibility checks require installed agents/auth and may consume quota.
  For this fork's local pilot, reuse the existing Claude ACP installation/login;
  do not install or launch `codex-acp`. `doctor` is offline and does not prove
  provider authentication; missing unused profiles can make its overall result
  fail.
- Keep each fix on its own branch and PR. Default PR target is
  `iliagon/acp-mcp:master`; publish upstream only when requested. Do not merge
  without authorization or assume pending PRs are already in master.
- Preserve unrelated local files such as `.idea/`. Keep generated artifacts and
  machine-specific pilot configuration out of commits; `dist/` is ignored.
