import { useEffect, useState } from "react";
import { formatNumber, formatDateTime } from "../../i18n.js";
import { useTranslation } from "../locale";
import {
  artifactMessages,
  type ArtifactMessageKey,
} from "../locales/artifacts";
import type { Participant, Session, WorkTask } from "../types";
import { AttachmentView } from "./AttachmentView";

export interface TaskTrayProps {
  tasks: WorkTask[];
  participants: Participant[];
  session: Session | null;
  showHistory: boolean;
  onCancel: (requestId: string) => Promise<void> | void;
  onError: (message: string) => void;
}

const terminalStates = new Set<WorkTask["status"]>([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

const applicationSummaries = new Map<string, ArtifactMessageKey>([
  ["正在保存结果", "saving"],
  ["正在准备文件", "preparing"],
  ["正在检查成果", "verifying"],
  ["成果文件已准备好", "resultsReady"],
  ["处理完成", "completed"],
  ["已取消", "cancelled"],
  ["等待处理", "queued"],
  ["正在取消", "cancelling"],
  ["附件传输中断，正在重试", "retryingDownload"],
  ["协作任务已取消", "cancelled"],
  ["正在保存成果", "saving"],
  ["正在发送成果", "delivering"],
  ["任务已取消", "cancelled"],
  ["成果已生成，正在重试上传", "retryingUpload"],
  ["等待协作 Bot 的成果", "waiting_for_bot"],
  ["已交付", "delivered"],
  ["协作成果已交付", "delivered"],
  ["正在读取附件", "downloading"],
  ["正在处理任务", "running"],
]);

function localizeApplicationSummary(
  summary: string,
  translate: (
    key: ArtifactMessageKey,
    values?: Record<string, string | number>,
  ) => string,
) {
  const key = applicationSummaries.get(summary);
  if (key) return translate(key);
  const step = summary.match(/^正在处理，第 (\d+) 步$/);
  if (step) {
    return translate("stepProgress", { step: formatNumber(Number(step[1])) });
  }
  const tool = summary.match(/^正在使用 ([A-Za-z0-9_.:-]+)$/);
  if (tool) return translate("usingTool", { tool: tool[1] });
  return undefined;
}

function stageKey(task: WorkTask): ArtifactMessageKey {
  if (Object.hasOwn(artifactMessages.en, task.stage))
    return task.stage as ArtifactMessageKey;
  return task.status;
}

function statusClass(task: WorkTask) {
  if (!terminalStates.has(task.status)) return "busy";
  if (task.status === "completed") return "online";
  if (task.status === "cancelled") return "";
  return "error";
}

export function TaskTray({
  tasks,
  participants,
  session,
  showHistory,
  onCancel,
  onError,
}: TaskTrayProps) {
  const t = useTranslation(artifactMessages);
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = tasks
    .filter(
      (task) =>
        showHistory ||
        !terminalStates.has(task.status) ||
        now - new Date(task.updatedAt).getTime() < 90000,
    )
    .sort((left, right) => {
      if (!showHistory) {
        const activeOrder =
          Number(terminalStates.has(left.status)) -
          Number(terminalStates.has(right.status));
        if (activeOrder !== 0) return activeOrder;
      }
      return (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    })
    .slice(0, showHistory ? 20 : 4);

  async function cancelTask(requestId: string) {
    if (cancelling.has(requestId)) return;
    setCancelling((previous) => new Set(previous).add(requestId));
    try {
      await onCancel(requestId);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling((previous) => {
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }

  return (
    <section
      id="task-tray"
      className={`task-tray${showHistory ? " show-history" : ""}`}
      aria-label={t("workHistory")}
      hidden={!visible.length && !showHistory}
    >
      {!visible.length && showHistory && (
        <p className="empty-tasks">{t("emptyWork")}</p>
      )}
      {visible.map((task) => {
        const pendingCancellation =
          !terminalStates.has(task.status) &&
          (task.cancelRequested || cancelling.has(task.requestId));
        const botName =
          participants.find((person) => person.id === task.botId)?.name ??
          task.botId;
        const headingStage = pendingCancellation
          ? t("cancelling")
          : t(stageKey(task));
        const translatedSummary = localizeApplicationSummary(task.summary, t);
        const summary = translatedSummary ?? task.summary;
        const showSummary =
          summary &&
          (translatedSummary === undefined || summary !== headingStage);
        return (
          <article
            key={task.requestId}
            className={`task-card task-${task.status}`}
            data-request-id={task.requestId}
          >
            <div className="task-heading">
              <span
                className={`status-dot ${statusClass(task)}`}
                aria-hidden="true"
              />
              <strong>{botName}</strong>
              <span
                className="task-stage"
                title={formatDateTime(task.updatedAt)}
              >
                {headingStage}
              </span>
              {task.toolCalls > 0 && (
                <span className="small muted">
                  {t("toolCalls", { count: formatNumber(task.toolCalls) })}
                </span>
              )}
              {!terminalStates.has(task.status) && (
                <button
                  className="text-button"
                  type="button"
                  disabled={pendingCancellation}
                  onClick={() => void cancelTask(task.requestId)}
                >
                  {t("cancel")}
                </button>
              )}
            </div>
            {showSummary && (
              <p className="task-summary" title={summary}>
                {summary}
              </p>
            )}
            {task.artifacts.length > 0 && (
              <div className="task-artifacts">
                {task.artifacts
                  .filter((attachment) => attachment.id)
                  .map((attachment) => (
                    <AttachmentView
                      key={attachment.id}
                      attachment={attachment}
                      session={session}
                      onError={onError}
                    />
                  ))}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
