import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import { PiRpcAgentClient } from "../../agent.js";
import { PiHistoryMapper } from "../../history-mapper.js";
import type { PiAgentMessage } from "../../rpc-types.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import { createPiExtensionHost } from "../index.js";
import { findChildSessionFile, pstack } from "./index.js";
import { PASEO_PSTACK_ENTRY_MARKER, pstackRuntimeBridge } from "./runtime-bridge.js";

const parentTodos = [
  { id: "write", content: "Write the adapter", status: "completed" as const },
  { id: "test", content: "Cover the sample shapes", status: "in_progress" as const },
  { id: "drop", content: "Skip this", status: "cancelled" as const },
];

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
  };
}

function todoItems(events: readonly AgentStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "todo" ? [event.item.items] : [],
  );
}

function subagentEvents(events: readonly AgentStreamEvent[]) {
  return events.flatMap((event) => (event.type === "provider_subagent" ? [event.event] : []));
}

describe("pstack Pi adapter", () => {
  test("emits the full TodoWrite list and drops cancelled rows", () => {
    const host = createPiExtensionHost();
    expect(
      host.mapToolCall({
        callId: "todo-run",
        toolName: "TodoWrite",
        args: { merge: true, todos: [{ id: "test", content: "patch", status: "in_progress" }] },
        status: "running",
        result: null,
      }),
    ).toBeUndefined();
    expect(
      host.mapToolCall({
        callId: "todo-fail",
        toolName: "TodoWrite",
        args: { merge: false, todos: parentTodos },
        status: "failed",
        result: textResult("Current todos:\n- write [completed] Write the adapter", {
          todos: parentTodos,
        }),
      }),
    ).toBeUndefined();

    const mapped = host.mapToolCall({
      callId: "todo-ok",
      toolName: "TodoWrite",
      args: { merge: true, todos: [{ id: "test", content: "patch", status: "in_progress" }] },
      status: "completed",
      result: textResult(
        "Current todos:\n- write [completed] Write the adapter\n- test [in_progress] Cover the sample shapes",
        { todos: parentTodos },
      ),
    });
    expect(mapped?.timeline).toEqual([
      {
        type: "todo",
        items: [
          { id: "write", text: "Write the adapter", status: "completed", completed: true },
          {
            id: "test",
            text: "Cover the sample shapes",
            status: "in_progress",
            completed: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(mapped?.timeline)).not.toContain("activeForm");
    expect(JSON.stringify(mapped?.timeline)).not.toContain("cancelled");
  });

  test("replays a TodoWrite snapshot from the tool result and from the branch bridge", async () => {
    const messages: PiAgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "todo-1",
            name: "TodoWrite",
            arguments: { merge: false, todos: parentTodos },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "todo-1",
        toolName: "TodoWrite",
        content: [{ type: "text", text: "Current todos:\n- write [completed] Write the adapter" }],
        details: { todos: parentTodos },
      },
    ];
    const replay = new PiHistoryMapper("pi");
    const replayed = todoItems(replay.mapMessages(messages));
    const host = createPiExtensionHost();
    const bridged = host.mapRuntimeNotification(
      `${PASEO_PSTACK_ENTRY_MARKER} ${JSON.stringify({
        customType: "pstack-todos",
        data: { todos: parentTodos },
      })}`,
    );
    expect(replayed).toEqual(todoItems(bridged?.events ?? []));
    expect(replayed[0]?.map((item) => item.id)).toEqual(["write", "test"]);

    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pstack" });
    const live: AgentStreamEvent[] = [];
    session.subscribe((event) => live.push(event));
    try {
      await session.startTurn("Track tasks");
      pi.latestSession().emit({ type: "turn_start" });
      pi.latestSession().emit({
        type: "extension_ui_request",
        id: "widget",
        method: "setWidget",
        widget: "pstack-todos",
      });
      pi.latestSession().emit({
        type: "extension_ui_request",
        id: "status",
        method: "setStatus",
        status: "Todos 1/3",
      });
      pi.latestSession().emit({
        type: "message_start",
        message: {
          role: "custom",
          customType: "pstack-todos",
          content: "",
          display: false,
          details: { todos: parentTodos },
        },
      });
      const beforeEnd = live.filter((event) => event.type === "timeline").length;
      pi.latestSession().emit({
        type: "extension_ui_request",
        id: "bridge",
        method: "notify",
        message: `${PASEO_PSTACK_ENTRY_MARKER} ${JSON.stringify({
          customType: "pstack-todos",
          data: { todos: parentTodos },
        })}`,
      });
      expect(live.some((event) => event.type === "permission_requested")).toBe(false);
      expect(
        live.some((event) => event.type === "timeline" && event.item.type === "notification"),
      ).toBe(false);
      expect(todoItems(live)).toEqual(replayed);
      expect(live.filter((event) => event.type === "timeline").length).toBeGreaterThan(beforeEnd);
    } finally {
      await session.close();
    }
  });

  test("maps a foreground agent, tails its transcript, and keeps the child's todos on the child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pstack-child-"));
    const transcript = join(dir, "2026-10-20T12-00-00_a1fdfc181c2145027.jsonl");
    const childTodo = "Child only";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "a1fdfc181c2145027" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-10-20T12:00:01.000Z",
        message: { role: "user", content: "look around" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "child-todo",
              name: "TodoWrite",
              arguments: {
                merge: false,
                todos: [{ id: "child-1", content: childTodo, status: "pending" }],
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "child-todo",
          toolName: "TodoWrite",
          content: [{ type: "text", text: `Current todos:\n- child-1 [pending] ${childTodo}` }],
          details: { todos: [{ id: "child-1", content: childTodo, status: "pending" }] },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "grand",
              name: "agent",
              arguments: { description: "Nested lookup", prompt: "go" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Child finished the scan." }],
        },
      }),
    ];
    await writeFile(transcript, `${lines.join("\r\n")}\r\n`);
    const windowsTranscript =
      "C:\\Users\\Ada Lovelace\\AppData\\pi\\agents\\2026-10-20T12-00-00_a1fdfc181c2145027.jsonl";
    const report = [
      "agentId: a1fdfc181c2145027",
      "description: Scan the workspace",
      "status: completed",
      "exit code: 0",
      "worktree: C:\\Users\\Ada Lovelace\\work",
      `transcript: ${transcript}`,
      "",
      "Child finished the scan.",
    ].join("\n");
    try {
      const host = createPiExtensionHost();
      const started = host.mapToolCall({
        callId: "call-1",
        toolName: "agent",
        args: {
          description: "Scan the workspace",
          prompt: "Look around",
          subagent_type: "explore",
          model: "pi/test",
          effort: "high",
          readonly: true,
        },
        status: "running",
        result: null,
      });
      expect(started?.subagents).toEqual([
        {
          type: "upsert",
          id: "call-1",
          title: "explore",
          description: "Scan the workspace",
          subtitle: "explore · pi/test",
          toolCallId: "call-1",
          status: "running",
        },
      ]);
      expect(started?.detail).toMatchObject({
        type: "sub_agent",
        subAgentType: "explore",
        description: "Scan the workspace",
      });

      const windows = host.mapToolCall({
        callId: "call-windows",
        toolName: "agent",
        args: { description: "Path check", subagent_type: "explore" },
        status: "completed",
        result: textResult(
          `agentId: path-1\nstatus: completed\nexit code: 0\ntranscript: ${windowsTranscript}\n\nignored`,
          { agentId: "path-1", status: "completed", exitCode: 0 },
        ),
      });
      expect(windows?.childSessions).toEqual([{ id: "path-1", file: windowsTranscript }]);
      expect(windows?.subagents?.some((event) => event.type === "remove")).toBe(false);

      const finished = host.mapToolCall({
        callId: "call-1",
        toolName: "agent",
        args: {
          description: "Scan the workspace",
          prompt: "Look around",
          subagent_type: "explore",
          model: "pi/test",
        },
        status: "completed",
        result: textResult(report, {
          agentId: "a1fdfc181c2145027",
          status: "completed",
          exitCode: 0,
        }),
      });
      expect(finished?.subagents?.map((event) => event.type)).toEqual(["remove", "upsert"]);
      expect(finished?.subagents?.[1]).toMatchObject({
        type: "upsert",
        id: "a1fdfc181c2145027",
        status: "completed",
        description: "Scan the workspace",
        subtitle: "explore · pi/test",
        cwd: "C:\\Users\\Ada Lovelace\\work",
        toolCallId: "call-1",
      });
      expect(finished?.childSessions).toEqual([{ id: "a1fdfc181c2145027", file: transcript }]);
      expect(
        finished?.subagents?.some(
          (event) => event.type === "timeline" && event.item.type === "assistant_message",
        ),
      ).toBe(false);

      const hydrated = await finished?.hydration;
      const childTodos = (hydrated ?? []).flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "timeline" &&
        event.event.item.type === "todo"
          ? [event.event]
          : [],
      );
      expect(childTodos).toEqual([
        expect.objectContaining({
          id: "a1fdfc181c2145027",
          item: expect.objectContaining({
            items: [expect.objectContaining({ id: "child-1", text: childTodo })],
          }),
        }),
      ]);
      expect(JSON.stringify(finished?.events ?? [])).not.toContain(childTodo);
      expect(
        (hydrated ?? []).some(
          (event) => event.type === "provider_subagent" && event.event.type === "upsert",
        ),
      ).toBe(false);
      expect(JSON.stringify(hydrated)).toContain("Child finished the scan.");
      expect(JSON.stringify(hydrated)).toContain("Nested lookup");

      const steered = host.mapToolCall({
        callId: "send-1",
        toolName: "send_message",
        args: { to: "a1fdfc181c2145027", message: "Focus on tests" },
        status: "completed",
        result: textResult("sent"),
      });
      expect(steered?.subagents).toEqual([]);
      const stopped = host.mapToolCall({
        callId: "stop-1",
        toolName: "stop_agent",
        args: { id: "a1fdfc181c2145027" },
        status: "completed",
        result: textResult("stopped"),
      });
      expect(stopped?.subagents).toEqual([
        { type: "upsert", id: "a1fdfc181c2145027", status: "canceled" },
      ]);
      expect(
        host.mapToolCall({
          callId: "list-1",
          toolName: "list_agents",
          args: {},
          status: "completed",
          result: textResult("[]"),
        }),
      ).toBeUndefined();
      expect(
        host.mapToolCall({
          callId: "stop-unknown",
          toolName: "stop_agent",
          args: { id: "missing" },
          status: "completed",
          result: textResult("missing"),
        }),
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a background agent running until the pstack-agent completion message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pstack-bg-"));
    const sessionDir = join(dir, "agents");
    const sessionId = "bg-session";
    const transcript = join(sessionDir, `2026-10-20T12-03-00_${sessionId}.jsonl`);
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        transcript,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Background result." }],
          },
        })}\n`,
      );
      const host = createPiExtensionHost();
      const running = host.mapToolCall({
        callId: "call-bg",
        toolName: "agent",
        args: {
          description: "Scan the workspace",
          prompt: "Look around",
          subagent_type: "general",
          model: "pi/test",
          run_in_background: true,
        },
        status: "completed",
        result: textResult(
          '{"agentId":"a1fdfc181c2145027","status":"running"}\nThe agent is working in the background. Do not wait for it.',
          { agentId: "a1fdfc181c2145027", status: "running" },
        ),
      });
      expect(running?.subagents).toEqual([
        expect.objectContaining({
          id: "a1fdfc181c2145027",
          status: "running",
          description: "Scan the workspace",
          subtitle: "general · pi/test",
        }),
      ]);
      expect(running?.childSessions).toBeUndefined();

      const early = host.mapToolCall({
        callId: "send-early",
        toolName: "send_message",
        args: { to: "a1fdfc181c2145027", message: "Keep going" },
        status: "completed",
        result: textResult("queued"),
      });
      expect(early?.subagents).toEqual([
        {
          type: "timeline",
          id: "a1fdfc181c2145027",
          item: { type: "user_message", text: "Keep going" },
        },
      ]);

      const completion = [
        "pstack agent finished.",
        "agentId: a1fdfc181c2145027",
        "description: Scan the workspace",
        "status: completed",
        "exit code: 0",
        `transcript: ${transcript}`,
        "",
        "Background result.",
      ].join("\n");
      const messages: PiAgentMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bg",
              name: "agent",
              arguments: {
                description: "Scan the workspace",
                prompt: "Look around",
                subagent_type: "general",
                model: "pi/test",
                run_in_background: true,
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-bg",
          toolName: "agent",
          content: [
            {
              type: "text",
              text: '{"agentId":"a1fdfc181c2145027","status":"running"}\nThe agent is working in the background. Do not wait for it.',
            },
          ],
          details: { agentId: "a1fdfc181c2145027", status: "running" },
        },
        {
          role: "custom",
          customType: "pstack-agent",
          display: true,
          content: completion,
          details: {
            agentId: "a1fdfc181c2145027",
            status: "completed",
            exitCode: 0,
            outputFile: transcript,
          },
        },
      ];
      const mapper = new PiHistoryMapper("pi");
      const replayed = mapper.mapMessages(messages);
      const hydrated = await mapper.hydrate();
      const statuses = subagentEvents(replayed).flatMap((event) =>
        event.type === "upsert" ? [event.status] : [],
      );
      expect(statuses).toEqual(["running", "running", "completed"]);
      expect(JSON.stringify(hydrated)).toContain("Background result.");
      expect(
        subagentEvents(replayed).some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            event.item.text === "Background result.",
        ),
      ).toBe(false);
      expect(
        replayed.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.detail.type === "plain_text" &&
            event.item.detail.text === completion,
        ),
      ).toBe(true);

      const orphan = host.mapCustomMessage({
        role: "custom",
        customType: "pstack-agent",
        display: true,
        content:
          "pstack agent finished.\nagentId: orphan\ndescription: Notes\nstatus: failed\nexit code: 1\n\nboom",
        details: { agentId: "orphan", status: "failed", exitCode: 1 },
      });
      expect(orphan?.subagents).toEqual([
        expect.objectContaining({
          type: "upsert",
          id: "orphan",
          status: "failed",
          description: "Notes",
        }),
        {
          type: "timeline",
          id: "orphan",
          item: { type: "assistant_message", text: "boom" },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finds a child file that appears after the pstack-agents snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pstack-poll-"));
    const sessionId = "sess-1";
    const session = pstack.createSession();
    try {
      const missing = session.mapRuntimeNotification?.(
        `${PASEO_PSTACK_ENTRY_MARKER} ${JSON.stringify({
          customType: "pstack-agents",
          data: {
            agent: {
              id: "a1fdfc181c2145027",
              description: "Scan the workspace",
              subagentType: "explore",
              model: "pi/test",
              sessionId,
              sessionDir: dir,
              cwd: "C:\\work\\my project",
              startedAt: "2026-10-20T12:00:00.000Z",
            },
            status: "running",
          },
        })}`,
      );
      expect(missing?.childSessions).toBeUndefined();
      expect(missing?.subagents?.[0]).toMatchObject({
        id: "a1fdfc181c2145027",
        status: "running",
        cwd: "C:\\work\\my project",
        subtitle: "explore · pi/test",
      });
      expect(session.poll?.()).toBeUndefined();

      const older = join(dir, `2026-10-20T11-00-00_${sessionId}.jsonl`);
      const newer = join(dir, `2026-10-20T12-00-00_${sessionId}.jsonl`);
      await writeFile(older, "{}\n");
      await writeFile(newer, "{}\n");
      expect(findChildSessionFile(dir, sessionId)).toBe(newer);
      expect(session.poll?.()?.childSessions).toEqual([{ id: "a1fdfc181c2145027", file: newer }]);
      const ended = session.mapCustomMessage?.({
        role: "custom",
        customType: "pstack-agents",
        content: "",
        display: false,
        details: {
          agent: {
            id: "a1fdfc181c2145027",
            description: "Scan the workspace",
            sessionId,
            sessionDir: dir,
          },
          status: "stopped",
          exitCode: 0,
          finalText: "stopped early",
        },
      });
      expect(ended?.subagents?.[0]).toMatchObject({
        id: "a1fdfc181c2145027",
        status: "canceled",
      });
      expect(ended?.subagents?.some((event) => event.type === "timeline")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports custom branch entries through the parent runtime bridge", () => {
    const listeners = new Map<string, (event: unknown, ctx?: unknown) => void>();
    const pi = {
      on: (name: string, listener: (event: unknown, ctx?: unknown) => void) =>
        listeners.set(name, listener),
    };
    new Function("pi", pstackRuntimeBridge)(pi);
    const notifications: string[] = [];
    const ctx = {
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: {
        getBranch: () => [
          { type: "message", customType: "pstack-todos", data: { todos: [] } },
          { type: "custom", customType: "other", data: { todos: parentTodos } },
          {
            id: "todos-1",
            type: "custom",
            customType: "pstack-todos",
            data: { todos: parentTodos },
          },
        ],
      },
    };
    listeners.get("session_start")?.({}, ctx);
    listeners.get("tool_execution_end")?.({}, ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(PASEO_PSTACK_ENTRY_MARKER);
    const host = createPiExtensionHost();
    expect(
      todoItems(host.mapRuntimeNotification(notifications[0]!)?.events ?? [])[0]?.map(
        (item) => item.status,
      ),
    ).toEqual(["completed", "in_progress"]);
    ctx.sessionManager.getBranch = () => [
      {
        id: "todos-1",
        type: "custom",
        customType: "pstack-todos",
        data: { todos: [{ id: "test", content: "Cover the sample shapes", status: "completed" }] },
      },
    ];
    listeners.get("turn_end")?.({}, ctx);
    expect(notifications).toHaveLength(2);
    ctx.sessionManager.getBranch = () => {
      throw new Error("closed");
    };
    expect(() => listeners.get("message_end")?.({}, ctx)).not.toThrow();
  });

  test("a background completion on the rpc stream updates the same agent", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pstack" });
    const live: AgentStreamEvent[] = [];
    session.subscribe((event) => live.push(event));
    try {
      await session.startTurn("Delegate");
      pi.latestSession().emit({ type: "turn_start" });
      pi.latestSession().emit({
        type: "tool_execution_start",
        toolCallId: "call-bg",
        toolName: "agent",
        args: {
          description: "Scan the workspace",
          prompt: "Look around",
          subagent_type: "general",
          run_in_background: true,
        },
      });
      pi.latestSession().emit({
        type: "tool_execution_end",
        toolCallId: "call-bg",
        toolName: "agent",
        result: {
          content: [
            {
              type: "text",
              text: '{"agentId":"a1fdfc181c2145027","status":"running"}\nThe agent is working in the background. Do not wait for it.',
            },
          ],
          details: { agentId: "a1fdfc181c2145027", status: "running" },
        },
      });
      const before = live.length;
      pi.latestSession().emit({
        type: "message_start",
        message: { role: "custom", customType: "pstack-agent", content: "pending", display: true },
      });
      expect(live.length).toBe(before);
      pi.latestSession().emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "pstack-agent",
          display: true,
          content:
            "pstack agent finished.\nagentId: a1fdfc181c2145027\ndescription: Scan the workspace\nstatus: stopped\nexit code: 0\n\nStopped by the user.",
          details: { agentId: "a1fdfc181c2145027", status: "stopped", exitCode: 0 },
        },
      });
      const agents = subagentEvents(live).filter((event) => event.type === "upsert");
      expect(agents.map((event) => ({ id: event.id, status: event.status }))).toEqual([
        { id: "call-bg", status: "running" },
        { id: "a1fdfc181c2145027", status: "running" },
        { id: "a1fdfc181c2145027", status: "canceled" },
      ]);
      const store = new ProviderSubagentStore();
      for (const event of subagentEvents(live)) store.apply("parent", "pi", event);
      expect(store.list("parent")).toMatchObject([
        {
          id: "a1fdfc181c2145027",
          status: "canceled",
          description: "Scan the workspace",
        },
      ]);
      expect(JSON.stringify(live)).toContain("Stopped by the user.");
      expect(
        live.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.name === "pstack-agent",
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });
});
