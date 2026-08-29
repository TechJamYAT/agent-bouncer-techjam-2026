import type {
  Agent,
  AuthorizationDecision,
  DirectConversationSummary,
  Group,
  ProtectedResource,
} from "./types";

export type PersonalSection = "conversations" | "agents" | "knowledge";
export type GroupSection = "chat" | "tasks" | "agents" | "knowledge" | "members" | "audit";

function timeAgo(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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
  return (
    <article className="workspace-agent-card">
      <button className="workspace-agent-open" onClick={onOpen} disabled={!onOpen}>
        <span className="workspace-agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
        <span>
          <strong>{agent.name}</strong>
          <small>{agent.role}{agent.scope === "coordinator" ? " · 系统调度" : ""}</small>
        </span>
      </button>
      <div className="workspace-agent-card-actions">
        <em className={`workspace-agent-status status-${agent.status}`}>{agent.status}</em>
        {onEdit && <button onClick={onEdit}>编辑</button>}
        {onDelete && <button className="danger" onClick={onDelete}>删除</button>}
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
  if (resources.length === 0) {
    return <div className="workspace-empty compact"><span>◇</span><p>{emptyText}</p></div>;
  }
  return (
    <div className="knowledge-grid">
      {resources.map((resource) => (
        <button className="knowledge-card" key={resource.id} onClick={() => onOpen(resource)}>
          <span>{resource.kind === "document" ? "文档" : resource.kind === "message" ? "消息" : "产物"}</span>
          <h3>{resource.title}</h3>
          <p>{resource.content.slice(0, 110)}{resource.content.length > 110 ? "…" : ""}</p>
          <small>{timeAgo(resource.updatedAt)}</small>
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
  const personalAgents = agents.filter((agent) => agent.scope === "personal");
  return (
    <section className="workspace-page">
      <header className="workspace-toolbar">
        <div className="toolbar-identity"><span className="eyebrow">个人空间</span><h1>{section === "knowledge" ? "我的知识库" : section === "agents" ? "我的 Agents" : "对话"}</h1></div>
        <span />
        {section === "knowledge"
          ? <button className="button button-primary" onClick={onCreateResource}>＋ 新建资料</button>
          : <button className="button button-primary" onClick={onCreateAgent}>＋ 创建个人 Agent</button>}
      </header>
      <div className="workspace-surface">
        {section === "knowledge" ? (
          <KnowledgeCards resources={resources} emptyText="还没有私人知识资源。" onOpen={onOpenResource} />
        ) : section === "conversations" ? (
          <div className="direct-chat-placeholder standalone"><span>◌</span><h2>从左侧选择一个对话</h2><p>好友和单独 Agent 对话已经归入最左侧导航栏。</p></div>
        ) : (
          <div className="workspace-agent-grid">
            {personalAgents.map((agent) => <AgentTile
              key={agent.id}
              agent={agent}
              onOpen={() => onOpenAgent(agent.id)}
              onEdit={() => onEditAgent(agent.id)}
              onDelete={() => onDeleteAgent(agent)}
            />)}
            {personalAgents.length === 0 && <div className="workspace-empty"><span>◇</span><h2>还没有个人 Agent</h2><p>创建后，可以从个人对话中持续与它协作。</p><button className="button button-primary" onClick={onCreateAgent}>创建个人 Agent</button></div>}
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
  const canManageAgents = group.role === "owner" || group.role === "admin";
  const tabs: Array<{ id: GroupSection; label: string }> = [
    { id: "chat", label: "群聊" }, { id: "tasks", label: "项目文件" },
    { id: "agents", label: "群组 Agents" }, { id: "knowledge", label: "群组知识库" },
    { id: "members", label: "成员" }, { id: "audit", label: "审计" },
  ];
  return (
    <section className="workspace-page group-workspace-page">
      <header className="workspace-toolbar">
        <div className="toolbar-identity"><span className="eyebrow">群组空间 · {group.role}</span><h1>{group.name}</h1></div>
        <nav className="workspace-tabs group-tabs">
          {tabs.map((tab) => <button key={tab.id} className={section === tab.id ? "selected" : ""} onClick={() => onSectionChange(tab.id)}>{tab.label}</button>)}
        </nav>
        <span className="group-toolbar-spacer" aria-hidden="true" />
      </header>
      {section === "tasks" ? children : section === "chat" ? chatContent : (
        <div className="workspace-surface">
          {section === "agents" && (
            <div className="workspace-agent-grid">
              {canManageAgents && <button className="workspace-add-card" onClick={onCreateAgent}><span>＋</span><strong>创建群组 Agent</strong><small>添加产品、设计、工程等新角色</small></button>}
              {agents.map((agent) => <AgentTile
                key={agent.id}
                agent={agent}
                onOpen={agent.scope === "coordinator" ? undefined : () => onOpenAgent(agent.id)}
                onEdit={!agent.systemManaged && canManageAgents ? () => onEditAgent(agent.id) : undefined}
                onDelete={!agent.systemManaged && canManageAgents ? () => onDeleteAgent(agent) : undefined}
              />)}
            </div>
          )}
          {section === "knowledge" && <><div className="surface-inline-action"><button className="button button-primary" onClick={onCreateResource}>＋ 添加群资料</button></div><KnowledgeCards resources={resources} emptyText="这个群还没有共享知识资源。" onOpen={onOpenResource} /></>}
          {section === "members" && membersContent}
          {section === "audit" && <div className="activity-list wide">{decisions.slice(0, 12).map((decision) => <article key={decision.id}><span className={`activity-dot activity-${decision.decision}`} /><div><strong>{decision.reasonCode}</strong><small>{decision.action} · {timeAgo(decision.occurredAt)}</small></div><code>{decision.decision}</code></article>)}{decisions.length === 0 && <div className="workspace-empty compact"><p>这个群还没有授权决策。</p></div>}</div>}
        </div>
      )}
    </section>
  );
}
