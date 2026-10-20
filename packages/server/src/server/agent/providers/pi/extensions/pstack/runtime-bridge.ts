export const PASEO_PSTACK_ENTRY_MARKER = "PASEO_PSTACK_ENTRY";

/**
 * Runs inside the parent Pi process. `type: "custom"` session entries (pstack-todos, pstack-agents)
 * are not returned by get_messages, so the current branch is reported through ctx.ui.notify.
 * A second write of the same entry id with new data is reported again.
 */
export const pstackRuntimeBridge = `
  const pstackSeen = new Set();
  const reportPstackBranch = (ctx) => {
    let branch;
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return;
    }
    if (!Array.isArray(branch)) return;
    for (const entry of branch) {
      if (!entry || entry.type !== "custom") continue;
      if (entry.customType !== "pstack-todos" && entry.customType !== "pstack-agents") continue;
      const signature = String(entry.id ?? "") + ":" + JSON.stringify(entry.data ?? null);
      if (pstackSeen.has(signature)) continue;
      pstackSeen.add(signature);
      ctx.ui.notify(
        ${JSON.stringify(`${PASEO_PSTACK_ENTRY_MARKER} `)} +
          JSON.stringify({ customType: entry.customType, data: entry.data ?? null }),
        "info",
      );
    }
  };
  pi.on("session_start", (_event, ctx) => {
    reportPstackBranch(ctx);
  });
  pi.on("message_end", (_event, ctx) => {
    reportPstackBranch(ctx);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    reportPstackBranch(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    reportPstackBranch(ctx);
  });
`;
