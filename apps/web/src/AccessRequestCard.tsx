import { useEffect, useRef, useState } from "react";
import type { AccessRequest, User } from "./types";

interface AccessRequestCardProps {
  request: AccessRequest;
  currentUser: User;
  onResolve: (id: string, resolution: "approve" | "reject") => Promise<void>;
}

export function AccessRequestCard({ request, currentUser, onResolve }: AccessRequestCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canApprove = request.ownerUserId === currentUser.id;

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
      aria-label={request.action === "forward" ? "Agent 请求转发受保护资料" : "Agent 请求披露受保护资料"}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!canApprove || resolving) return;
        if (event.key === "Escape") { event.preventDefault(); resolve("reject"); }
        if (event.key === "Enter") { event.preventDefault(); resolve("approve"); }
      }}
    >
      <div className="round-extension-heading"><span>✋</span>Agent 提起资料{request.action === "forward" ? "转发" : "原文交付"}申请</div>
      <p className="round-extension-question">
        {request.action === "forward"
          ? <>是否允许 {request.agentName} 将「{request.resourceTitle}」转发给 {request.recipientName}？</>
          : <>是否允许 {request.agentName} 向 {request.requesterName} 交付「{request.resourceTitle}」原文？</>}
      </p>
      <p className="round-extension-reason">
        Bouncer 已阻止直接执行。批准只对当前 Run、这份资料和指定接收者有效。
      </p>
      <small>等待期间 Runtime 已停止，旧凭证已销毁。</small>
      <small>未在 {new Date(request.expiresAt).toLocaleTimeString()} 前处理将自动拒绝。</small>
      {canApprove ? (
        <div className="round-extension-actions">
          <button onClick={() => resolve("reject")} disabled={resolving !== null}>
            {resolving === "reject" ? "处理中…" : "拒绝"} <kbd>Esc</kbd>
          </button>
          <button className="allow" onClick={() => resolve("approve")} disabled={resolving !== null}>
            {resolving === "approve" ? "审批中…" : "同意并继续"} <kbd>↵</kbd>
          </button>
        </div>
      ) : <span className="round-extension-waiting">等待资料所有者处理</span>}
      {error && <p className="access-request-error" role="alert">{error}</p>}
    </section>
  );
}
