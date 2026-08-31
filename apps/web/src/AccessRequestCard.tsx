import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import type { AccessRequest, User } from "./types";

interface AccessRequestCardProps {
  request: AccessRequest;
  currentUser: User;
  onResolve: (id: string, resolution: "approve" | "reject") => Promise<void>;
}

export function AccessRequestCard({ request, currentUser, onResolve }: AccessRequestCardProps) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLElement>(null);
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canApprove = request.ownerUserId === currentUser.id;
  const actionLabel = request.action === "list"
    ? t("查看私人资料目录", "view private resource catalog")
    : request.action === "read"
      ? t("读取资料", "read resource")
      : request.action === "forward"
        ? t("转发资料", "forward resource")
        : t("交付原文", "disclose source text");

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const resolve = (resolution: "approve" | "reject") => {
    setResolving(resolution);
    setError(null);
    void onResolve(request.id, resolution)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setResolving(null));
  };

  return (
    <section
      ref={cardRef}
      className="round-extension-card conversation-permission-card access-request-card"
      role="alertdialog"
      aria-label={t(`Agent 请求${actionLabel}`, `Agent requests permission to ${actionLabel}`)}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!canApprove || resolving) return;
        if (event.key === "Escape") { event.preventDefault(); resolve("reject"); }
        if (event.key === "Enter") { event.preventDefault(); resolve("approve"); }
      }}
    >
      <div className="round-extension-heading"><span>✋</span>{t(`Agent 提起${actionLabel}申请`, `Agent requests permission to ${actionLabel}`)}</div>
      <p className="round-extension-question">
        {request.action === "list"
          ? <>{t(`是否允许 ${request.agentName} 在本次 Run 查看你的私人资料标题、类型和创建时间？`, `Allow ${request.agentName} to view the titles, types, and creation times in your private catalog for this Run?`)}</>
          : request.action === "read"
            ? <>{t(`是否允许 ${request.agentName} 在本次 Run 读取「${request.resourceTitle}」并用于当前回答？`, `Allow ${request.agentName} to read “${request.resourceTitle}” for the current response in this Run?`)}</>
            : request.action === "forward"
          ? <>{t(`是否允许 ${request.agentName} 将「${request.resourceTitle}」转发给 ${request.recipientName}？`, `Allow ${request.agentName} to forward “${request.resourceTitle}” to ${request.recipientName}?`)}</>
          : <>{t(`是否允许 ${request.agentName} 向 ${request.requesterName} 交付「${request.resourceTitle}」原文？`, `Allow ${request.agentName} to disclose the source text of “${request.resourceTitle}” to ${request.requesterName}?`)}</>}
      </p>
      <p className="round-extension-reason">
        {request.action === "list"
          ? t("只返回最小元数据，不授权读取正文、密封处理、原文交付或转发。", "Only minimal metadata is returned. This does not authorize reading, sealed processing, disclosure, or forwarding.")
          : request.action === "forward"
            ? t("Bouncer 已阻止直接外发。批准只对当前 Run、这份资料和指定接收者有效。", "Bouncer blocked direct forwarding. Approval applies only to this Run, resource, and recipient.")
            : t("Bouncer 已阻止直接读取。批准只对当前 Run、这份资料和当前 Agent 有效。", "Bouncer blocked direct access. Approval applies only to this Run, resource, and Agent.")}
      </p>
      <small>{t("等待期间 Runtime 已停止，旧凭证已销毁。", "The Runtime is stopped and its previous credential destroyed while waiting.")}</small>
      <small>{t(`未在 ${new Date(request.expiresAt).toLocaleTimeString()} 前处理将自动拒绝。`, `This request will be denied automatically if not resolved by ${new Date(request.expiresAt).toLocaleTimeString()}.`)}</small>
      {canApprove ? (
        <div className="round-extension-actions">
          <button onClick={() => resolve("reject")} disabled={resolving !== null}>
            {resolving === "reject" ? t("处理中…", "Processing…") : t("拒绝", "Deny")} <kbd>Esc</kbd>
          </button>
          <button className="allow" onClick={() => resolve("approve")} disabled={resolving !== null}>
            {resolving === "approve" ? t("审批中…", "Approving…") : t("同意并继续", "Approve and continue")} <kbd>↵</kbd>
          </button>
        </div>
      ) : <span className="round-extension-waiting">{t("等待资料所有者处理", "Waiting for the resource owner")}</span>}
      {error && <p className="access-request-error" role="alert">{error}</p>}
    </section>
  );
}
