import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentTaskItem, AgentTimelineItem } from "../../../../agent-sdk-types.js";
import type { ProviderSubagentInputEvent } from "../../../../provider-subagents/store.js";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type {
  PiExtension,
  PiExtensionCustomMapping,
  PiExtensionToolCall,
  PiExtensionToolMapping,
} from "../contract.js";
import { PASEO_PSTACK_ENTRY_MARKER, pstackRuntimeBridge } from "./runtime-bridge.js";

const Todo = z.object({
  id: z.string().trim().min(1),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});
const TodoSnapshot = z.object({ todos: z.array(Todo) }).passthrough();
const AgentArgs = z
  .object({
    description: z.string().trim().min(1),
    prompt: z.string().optional(),
    subagent_type: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    run_in_background: z.boolean().optional(),
    isolation: z.string().optional(),
    readonly: z.boolean().optional(),
  })
  .passthrough();
const AgentResult = z
  .object({
    agentId: z.string().trim().min(1),
    status: z.string(),
    exitCode: z.number().optional(),
    outputFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const SendArgs = z.object({ to: z.string().trim().min(1), message: z.string() }).passthrough();
const StopArgs = z.object({ id: z.string().trim().min(1) }).passthrough();
const AgentRecord = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().optional(),
    subagentType: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    readonly: z.boolean().optional(),
    sessionId: z.string().trim().min(1).optional(),
    sessionDir: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
  })
  .passthrough();
const AgentState = z
  .object({
    agent: AgentRecord,
    status: z.string(),
    exitCode: z.number().optional(),
    finalText: z.string().optional(),
  })
  .passthrough();
const BridgeEntry = z.object({
  customType: z.enum(["pstack-todos", "pstack-agents"]),
  data: z.unknown(),
});

type AgentStatus = "running" | "completed" | "failed" | "canceled";

interface PendingChildFile {
  sessionDir: string;
  sessionId: string;
}

/**
 * Paseo's task status has no cancelled. Dropping the row matches Claude's deleted tasks: it
 * leaves the list and is not counted as done.
 */
function todoItems(todos: z.infer<typeof Todo>[]): AgentTaskItem[] {
  const items: AgentTaskItem[] = [];
  for (const todo of todos) {
    if (todo.status === "cancelled") continue;
    items.push({
      id: todo.id,
      text: todo.content,
      status: todo.status,
      completed: todo.status === "completed",
    });
  }
  return items;
}

function todoTimeline(todos: z.infer<typeof Todo>[]): AgentTimelineItem[] {
  return [{ type: "todo", items: todoItems(todos) }];
}

function agentStatus(value: string): AgentStatus {
  if (value === "completed") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "stopped" || value === "cancelled" || value === "canceled" || value === "aborted") {
    return "canceled";
  }
  return "running";
}

function labeledLine(text: string, label: string): string | undefined {
  // Optional brackets are how the report marks a line that may be absent.
  const match = text.match(new RegExp(`^\\[?${label}:\\s*(.*?)\\s*\\]?\\s*$`, "im"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function reportBody(text: string): string | undefined {
  const splitAt = text.search(/\n\s*\n/);
  if (splitAt < 0) return undefined;
  const body = text.slice(splitAt).trim();
  return body || undefined;
}

function messageText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

function payloadData(value: { details?: unknown }): unknown {
  const record = value as { details?: unknown; data?: unknown };
  return record.data === undefined ? record.details : record.data;
}

/** `<sessionDir>/<iso-ts>_<sessionId>.jsonl`. The timestamp sorts lexicographically. */
export function findChildSessionFile(sessionDir: string, sessionId: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  const name = names
    .filter((entry) => entry.endsWith(suffix))
    .sort()
    .at(-1);
  return name ? join(sessionDir, name) : undefined;
}

function subtitle(type: string | undefined, model: string | undefined): string | undefined {
  const parts = [type?.trim(), model?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export const pstack: PiExtension = {
  id: "pstack",
  runtimeBridge: pstackRuntimeBridge,
  createSession: () => {
    const idsByAgent = new Map<string, string>();
    const provisionalIds = new Set<string>();
    const readSessions = new Set<string>();
    const followedIds = new Set<string>();
    const pendingFiles = new Map<string, PendingChildFile>();

    const remember = (agentId: string, descriptorId: string) => {
      idsByAgent.set(agentId, descriptorId);
    };
    const childSession = (id: string, file: string | undefined) => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      followedIds.add(id);
      pendingFiles.delete(id);
      return [{ id, file }];
    };
    const resolveFile = (id: string, explicit: string | undefined) => {
      if (explicit) return explicit;
      const located = pendingFiles.get(id);
      if (!located) return undefined;
      return findChildSessionFile(located.sessionDir, located.sessionId);
    };
    const rememberPending = (id: string, sessionDir?: string, sessionId?: string) => {
      if (!sessionDir || !sessionId || followedIds.has(id)) return;
      pendingFiles.set(id, { sessionDir, sessionId });
    };

    const mapTodoWrite = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      if (call.toolName !== "TodoWrite" || call.status !== "completed") return undefined;
      const details = TodoSnapshot.safeParse(
        call.result && typeof call.result === "object" ? call.result.details : null,
      );
      if (!details.success) return undefined;
      return { timeline: todoTimeline(details.data.todos) };
    };

    const finishAgent = (
      call: PiExtensionToolCall,
      text: string,
      detail: PiExtensionToolMapping["detail"],
      base: Omit<Extract<ProviderSubagentInputEvent, { type: "upsert" }>, "id" | "status">,
    ): PiExtensionToolMapping => {
      const parsed = AgentResult.safeParse(
        call.result && typeof call.result === "object" ? call.result.details : null,
      );
      if (!parsed.success) {
        return { detail, subagents: [{ ...base, id: call.callId, status: "failed" }] };
      }
      const agentId = parsed.data.agentId;
      remember(agentId, agentId);
      const status = agentStatus(parsed.data.status);
      const knownFile = followedIds.has(agentId);
      const file = knownFile
        ? undefined
        : resolveFile(agentId, parsed.data.outputFile ?? labeledLine(text, "transcript"));
      const worktree = labeledLine(text, "worktree");
      const subagents: ProviderSubagentInputEvent[] = [];
      if (provisionalIds.delete(call.callId) && agentId !== call.callId) {
        subagents.push({ type: "remove", id: call.callId });
      }
      subagents.push({
        ...base,
        id: agentId,
        status,
        ...(worktree ? { cwd: worktree } : {}),
      });
      const body = status === "running" ? undefined : reportBody(text);
      if (!knownFile && !file && body) {
        subagents.push({
          type: "timeline",
          id: agentId,
          item: { type: "assistant_message", text: body },
        });
      }
      const sessions = childSession(agentId, file);
      return {
        detail,
        subagents,
        ...(sessions.length > 0 ? { childSessions: sessions } : {}),
      };
    };

    const mapAgent = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      const args = AgentArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const title = args.data.subagent_type?.trim() || "agent";
      const description = args.data.description;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: title,
        description,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      const base = {
        type: "upsert" as const,
        title,
        description,
        subtitle: subtitle(args.data.subagent_type, args.data.model),
        toolCallId: call.callId,
      };
      if (call.status === "running") {
        provisionalIds.add(call.callId);
        return { detail, subagents: [{ ...base, id: call.callId, status: "running" }] };
      }
      if (call.status === "failed") {
        return { detail, subagents: [{ ...base, id: call.callId, status: "failed" }] };
      }
      return finishAgent(call, detail.log, detail, base);
    };

    const mapSend = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      if (call.toolName !== "send_message" || call.status === "running") return undefined;
      const args = SendArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = idsByAgent.get(args.data.to);
      if (!id) return undefined;
      if (call.status === "failed") return { subagents: [] };
      // A followed or located transcript already contains the steer. Inject only when this
      // session has no child file to read.
      const subagents: ProviderSubagentInputEvent[] =
        followedIds.has(id) || pendingFiles.has(id)
          ? []
          : [
              {
                type: "timeline",
                id,
                item: { type: "user_message", text: args.data.message },
              },
            ];
      return { subagents };
    };

    const mapStop = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      if (call.toolName !== "stop_agent" || call.status !== "completed") return undefined;
      const args = StopArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = idsByAgent.get(args.data.id);
      if (!id) return undefined;
      return { subagents: [{ type: "upsert", id, status: "canceled" }] };
    };

    const applyTodoSnapshot = (data: unknown): PiExtensionCustomMapping | undefined => {
      const parsed = TodoSnapshot.safeParse(data);
      if (!parsed.success) return undefined;
      return { subagents: [], timeline: todoTimeline(parsed.data.todos) };
    };

    const applyAgentState = (data: unknown): PiExtensionCustomMapping | undefined => {
      const parsed = AgentState.safeParse(data);
      if (!parsed.success) return undefined;
      const agent = parsed.data.agent;
      const id = idsByAgent.get(agent.id) ?? agent.id;
      remember(agent.id, id);
      const status = agentStatus(parsed.data.status);
      const explicit = parsed.data.finalText;
      const knownFile = followedIds.has(id);
      rememberPending(id, agent.sessionDir, agent.sessionId);
      const file = knownFile ? undefined : resolveFile(id, undefined);
      const subagents: ProviderSubagentInputEvent[] = [
        {
          type: "upsert",
          id,
          title: agent.subagentType?.trim() || "agent",
          description: agent.description,
          subtitle: subtitle(agent.subagentType, agent.model),
          status,
          ...(agent.cwd ? { cwd: agent.cwd } : {}),
        },
      ];
      if (!knownFile && !file && explicit && status !== "running") {
        subagents.push({
          type: "timeline",
          id,
          item: { type: "assistant_message", text: explicit },
        });
      }
      const sessions = childSession(id, file);
      return { subagents, ...(sessions.length > 0 ? { childSessions: sessions } : {}) };
    };

    const applyCompletion = (
      content: string,
      details: unknown,
    ): PiExtensionCustomMapping | undefined => {
      const parsed = AgentResult.safeParse(details);
      const agentId = parsed.success ? parsed.data.agentId : labeledLine(content, "agentId");
      if (!agentId) return undefined;
      const id = idsByAgent.get(agentId) ?? agentId;
      remember(agentId, id);
      const status = parsed.success
        ? agentStatus(parsed.data.status)
        : agentStatus(labeledLine(content, "status") ?? "completed");
      const description = labeledLine(content, "description");
      const worktree = labeledLine(content, "worktree");
      const knownFile = followedIds.has(id);
      const file = knownFile
        ? undefined
        : resolveFile(
            id,
            (parsed.success ? parsed.data.outputFile : undefined) ??
              labeledLine(content, "transcript"),
          );
      const subagents: ProviderSubagentInputEvent[] = [
        {
          type: "upsert",
          id,
          ...(description ? { description } : {}),
          status,
          ...(worktree ? { cwd: worktree } : {}),
        },
      ];
      const body = reportBody(content);
      if (!knownFile && !file && body && status !== "running") {
        subagents.push({
          type: "timeline",
          id,
          item: { type: "assistant_message", text: body },
        });
      }
      const sessions = childSession(id, file);
      return { subagents, ...(sessions.length > 0 ? { childSessions: sessions } : {}) };
    };

    return {
      mapToolCall(call) {
        if (call.toolName === "TodoWrite") return mapTodoWrite(call);
        if (call.toolName === "agent") return mapAgent(call);
        if (call.toolName === "send_message") return mapSend(call);
        if (call.toolName === "stop_agent") return mapStop(call);
        return undefined;
      },
      mapCustomMessage(message) {
        if (message.customType === "pstack-todos") return applyTodoSnapshot(payloadData(message));
        if (message.customType === "pstack-agents") return applyAgentState(payloadData(message));
        if (message.customType === "pstack-agent") {
          return applyCompletion(messageText(message.content), message.details);
        }
        return undefined;
      },
      mapRuntimeNotification(message) {
        const prefix = `${PASEO_PSTACK_ENTRY_MARKER} `;
        if (!message.startsWith(prefix)) return undefined;
        let raw: unknown;
        try {
          raw = JSON.parse(message.slice(prefix.length));
        } catch {
          return { subagents: [] };
        }
        const parsed = BridgeEntry.safeParse(raw);
        if (!parsed.success) return { subagents: [] };
        if (parsed.data.customType === "pstack-todos") return applyTodoSnapshot(parsed.data.data);
        return applyAgentState(parsed.data.data);
      },
      poll() {
        const childSessions: NonNullable<PiExtensionCustomMapping["childSessions"]> = [];
        for (const [id, pending] of pendingFiles) {
          const file = findChildSessionFile(pending.sessionDir, pending.sessionId);
          childSessions.push(...childSession(id, file));
        }
        return childSessions.length > 0 ? { subagents: [], childSessions } : undefined;
      },
    };
  },
};
