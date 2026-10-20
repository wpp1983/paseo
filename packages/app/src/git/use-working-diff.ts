import { useCallback, useEffect, useMemo } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
  useReviewFeedback,
} from "@/review";
import { resolveChangesCheckout } from "@/git/changes-checkout";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useWorkingDiffComparison } from "@/git/working-diff-comparison";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
  presentation?: string;
}

export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
  presentation,
}: UseWorkingDiffOptions) {
  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const checkout = resolveChangesCheckout(status);
  const gitStatus = checkout.kind === "git" && status?.isGit ? status : null;
  const isGit = checkout.kind === "git";
  const notGit = checkout.kind === "none" && status !== null && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const currentBranchName = checkout.label;

  const { comparison: diffMode, selectComparison } = useWorkingDiffComparison({
    serverId,
    workspaceId,
    cwd,
    isDirty: hasUncommittedChanges,
  });
  const diffModeForQuery = checkout.readOnly ? "uncommitted" : diffMode;
  const selectUncommitted = useCallback(() => selectComparison("uncommitted"), [selectComparison]);
  const selectBase = useCallback(() => selectComparison("base"), [selectComparison]);

  const {
    files,
    payloadError: diffPayloadError,
    diffTooLarge,
    isLoading: isDiffLoading,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffModeForQuery,
    baseRef,
    ignoreWhitespace,
    enabled: enabled && checkout.kind !== "none",
    queryScope,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffModeForQuery,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, diffModeForQuery, ignoreWhitespace, serverId, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey, presentation });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffModeForQuery,
    baseRef,
  });

  const reviewFeedback = useReviewFeedback({
    serverId,
    workspaceId,
    reviewDraftKey,
    attachment: reviewAttachment,
  });

  return {
    status,
    checkout,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode: diffModeForQuery,
    selectUncommitted,
    selectBase,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
    reviewFeedback,
  };
}

export function usePublishWorkingDiffAttachment({
  serverId,
  workspaceId,
  cwd,
  attachment,
  enabled,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  attachment: ReturnType<typeof useWorkingDiff>["reviewAttachment"];
  enabled: boolean;
}) {
  const scopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const attachments = attachment ? [attachment] : [];
    setWorkspaceAttachments({ scopeKey, attachments });
    return () => {
      const current = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];
      if (current === attachments) {
        clearWorkspaceAttachments({ scopeKey });
      }
    };
  }, [attachment, clearWorkspaceAttachments, enabled, scopeKey, setWorkspaceAttachments]);
}
