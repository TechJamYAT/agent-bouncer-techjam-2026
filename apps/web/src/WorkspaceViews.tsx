import type {
  Agent,
  AuthorizationDecision,
  DirectConversationSummary,
  Group,
  ProtectedResource,
} from "./types";
import { useI18n } from "./i18n";

export type PersonalSection = "conversations" | "agents" | "knowledge";
export type GroupSection = "chat" | "tasks" | "agents" | "knowledge" | "members" | "audit";

function timeAgo(value: string, t: (zh: string, en: string) => string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return t("刚刚", "Just now");
  if (minutes < 60) return t(`${minutes} 分钟前`, `${minutes}m ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`${hours} 小时前`, `${hours}h ago`);
  return t(`${Math.floor(hours / 24)} 天前`, `${Math.floor(hours / 24)}d ago`);
}

function AgentTile({
  agent,
  onOpen,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  onOpen?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const status = agent.status === "ready" ? t("就绪", "Ready")
    : agent.status === "busy" ? t("运行中", "Busy")
    : agent.status === "stopped" ? t("已停用", "Stopped")
    : agent.status === "error" ? t("错误", "Error") : t("已删除", "Deleted");
  return (
    <article className="workspace-agent-card">
      <button className="workspace-agent-open" onClick={onOpen} disabled={!onOpen}>
        <span className="workspace-agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
        <span>
          <strong>{agent.name}</strong>
          <small>{agent.role}{agent.scope === "coordinator" ? t(" · 系统调度", " · system coordinator") : ""}</small>
        </span>
      </button>
      <div className="workspace-agent-card-actions">
        <em className={`workspace-agent-status status-${agent.status}`}>{status}</em>
        {onEdit && <button onClick={onEdit}>{t("编辑", "Edit")}</button>}
        {onDelete && <button className="danger" onClick={onDelete}>{t("删除", "Delete")}</button>}
      </div>
    </article>
  );
}

function KnowledgeCards({
  resources,
  emptyText,
  onOpen,
}: {
  resources: ProtectedResource[];
  emptyText: string;
  onOpen: (resource: ProtectedResource) => void;
}) {
  const { t } = useI18n();
  if (resources.length === 0) {
    return <div className="workspace-empty compact"><span>◇</span><p>{emptyText}</p></div>;
  }
  return (
    <div className="knowledge-grid">
      {resources.map((resource) => (
        <button className="knowledge-card" key={resource.id} onClick={() => onOpen(resource)}>
          <span>{resource.kind === "document" ? t("文档", "Document") : resource.kind === "message" ? t("消息", "Message") : t("产物", "Artifact")}</span>
          <h3>{resource.title}</h3>
          <p>{resource.content.slice(0, 110)}{resource.content.length > 110 ? "…" : ""}</p>
          <small>{timeAgo(resource.updatedAt, t)}</small>
        </button>
      ))}
    </div>
  );
}

interface PersonalWorkspaceProps {
  section: PersonalSection;
  agents: Agent[];
  resources: ProtectedResource[];
  conversations: DirectConversationSummary[];
  onCreateAgent: () => void;
  onOpenAgent: (id: string) => void;
  onEditAgent: (id: string) => void;
  onDeleteAgent: (agent: Agent) => void;
  onCreateResource: () => void;
  onOpenResource: (resource: ProtectedResource) => void;
}

export function PersonalWorkspace({
  section,
  agents,
  resources,
  conversations,
  onCreateAgent,
  onOpenAgent,
  onEditAgent,
  onDeleteAgent,
  onCreateResource,
  onOpenResource,
}: PersonalWorkspaceProps) {
  const { t } = useI18n();
  const personalAgents = agents.filter((agent) => agent.scope === "personal");
  return (
    <section className="workspace-page">
      <header className="workspace-toolbar">
        <div className="toolbar-identity"><span className="eyebrow">{t("个人空间", "Personal space")}</span><h1>{section === "knowledge" ? t("我的知识库", "My knowledge") : section === "agents" ? t("我的 Agents", "My Agents") : t("对话", "Conversations")}</h1></div>
        <span />
        {section === "knowledge"
          ? <button className="button button-primary" onClick={onCreateResource}>＋ {t("新建资料", "New resource")}</button>
          : <button className="button button-primary" onClick={onCreateAgent}>＋ {t("创建个人 Agent", "Create personal Agent")}</button>}
      </header>
      <div className="workspace-surface">
        {section === "knowledge" ? (
          <KnowledgeCards resources={resources} emptyText={t("还没有私人知识资源。", "No private knowledge resources yet.")} onOpen={onOpenResource} />
        ) : section === "conversations" ? (
          <div className="direct-chat-placeholder standalone"><span>◌</span><h2>{t("从左侧选择一个对话", "Select a conversation on the left")}</h2><p>{t("好友和单独 Agent 对话已经归入最左侧导航栏。", "People and direct Agent conversations are listed in the left navigation.")}</p></div>
        ) : (
          <div className="workspace-agent-grid">
            {personalAgents.map((agent) => <AgentTile
              key={agent.id}
              agent={agent}
              onOpen={() => onOpenAgent(agent.id)}
              onEdit={() => onEditAgent(agent.id)}
              onDelete={() => onDeleteAgent(agent)}
            />)}
            {personalAgents.length === 0 && <div className="workspace-empty"><span>◇</span><h2>{t("还没有个人 Agent", "No personal Agents yet")}</h2><p>{t("创建后，可以从个人对话中持续与它协作。", "After creating one, you can keep collaborating from a direct conversation.")}</p><button className="button button-primary" onClick={onCreateAgent}>{t("创建个人 Agent", "Create personal Agent")}</button></div>}
          </div>
        )}
      </div>
    </section>
  );
}

interface GroupWorkspaceProps {
  group: Group;
  section: GroupSection;
  agents: Agent[];
  resources: ProtectedResource[];
  decisions: AuthorizationDecision[];
  onSectionChange: (section: GroupSection) => void;
  onCreateAgent: () => void;
  onOpenAgent: (id: string) => void;
  onEditAgent: (id: string) => void;
  onDeleteAgent: (agent: Agent) => void;
  onCreateResource: () => void;
  onOpenResource: (resource: ProtectedResource) => void;
  chatContent: React.ReactNode;
  membersContent: React.ReactNode;
  children?: React.ReactNode;
}

export function GroupWorkspace({
  group,
  section,
  agents,
  resources,
  decisions,
  onSectionChange,
  onCreateAgent,
  onOpenAgent,
  onEditAgent,
  onDeleteAgent,
  onCreateResource,
  onOpenResource,
  chatContent,
  membersContent,
  children,
}: GroupWorkspaceProps) {
  const { t } = useI18n();
  const canManageAgents = group.role === "owner" || group.role === "admin";
  const tabs: Array<{ id: GroupSection; label: string }> = [
    { id: "chat", label: t("群聊", "Group chat") }, { id: "tasks", label: t("项目文件", "Project files") },
    { id: "agents", label: t("群组 Agents", "Group Agents") }, { id: "knowledge", label: t("群组知识库", "Group knowledge") },
    { id: "members", label: t("成员", "Members") }, { id: "audit", label: t("审计", "Audit") },
  ];
  return (
    <section className="workspace-page group-workspace-page">
      <header className="workspace-toolbar">
        <div className="toolbar-identity"><span className="eyebrow">{t("群组空间", "Group space")} · {group.role}</span><h1>{group.name}</h1></div>
        <nav className="workspace-tabs group-tabs">
          {tabs.map((tab) => <button key={tab.id} className={section === tab.id ? "selected" : ""} onClick={() => onSectionChange(tab.id)}>{tab.label}</button>)}
        </nav>
        <span className="group-toolbar-spacer" aria-hidden="true" />
      </header>
      {section === "tasks" ? children : section === "chat" ? chatContent : (
        <div className="workspace-surface">
          {section === "agents" && (
            <div className="workspace-agent-grid">
              {canManageAgents && <button className="workspace-add-card" onClick={onCreateAgent}><span>＋</span><strong>{t("创建群组 Agent", "Create group Agent")}</strong><small>{t("添加产品、设计、工程等新角色", "Add product, design, engineering, or other roles")}</small></button>}
              {agents.map((agent) => <AgentTile
                key={agent.id}
                agent={agent}
                onOpen={agent.scope === "coordinator" ? undefined : () => onOpenAgent(agent.id)}
                onEdit={!agent.systemManaged && canManageAgents ? () => onEditAgent(agent.id) : undefined}
                onDelete={!agent.systemManaged && canManageAgents ? () => onDeleteAgent(agent) : undefined}
              />)}
            </div>
          )}
          {section === "knowledge" && <><div className="surface-inline-action"><button className="button button-primary" onClick={onCreateResource}>＋ {t("添加群资料", "Add group resource")}</button></div><KnowledgeCards resources={resources} emptyText={t("这个群还没有共享知识资源。", "This group has no shared knowledge resources yet.")} onOpen={onOpenResource} /></>}
          {section === "members" && membersContent}
          {section === "audit" && <div className="activity-list wide">{decisions.slice(0, 12).map((decision) => <article key={decision.id}><span className={`activity-dot activity-${decision.decision}`} /><div><strong>{decision.reasonCode}</strong><small>{decision.action} · {timeAgo(decision.occurredAt, t)}</small></div><code>{decision.decision}</code></article>)}{decisions.length === 0 && <div className="workspace-empty compact"><p>{t("这个群还没有授权决策。", "This group has no authorization decisions yet.")}</p></div>}</div>}
        </div>
      )}
    </section>
  );
}
