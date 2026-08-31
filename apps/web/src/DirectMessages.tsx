import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import type { DirectConversationSummary, HumanDirectMessage, User } from "./types";

function timeLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(date);
}

export function DirectConversationList({
  conversations,
  activeKey,
  onOpen,
  onCreateAgent,
}: {
  conversations: DirectConversationSummary[];
  activeKey: string | null;
  onOpen: (conversation: DirectConversationSummary) => void;
  onCreateAgent: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return conversations;
    return conversations.filter((item) =>
      `${item.title} ${item.subtitle} ${item.preview}`.toLocaleLowerCase().includes(normalized),
    );
  }, [conversations, query]);
  return (
    <aside className="direct-conversation-list">
      <div className="direct-list-title"><strong>{t("对话", "Conversations")}</strong><button onClick={onCreateAgent} title={t("创建个人 Agent", "Create personal Agent")}>＋</button></div>
      <label className="direct-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索", "Search")} /></label>
      <div className="direct-list-scroll">
        {visible.map((item) => {
          const key = `${item.peerType}:${item.peerId}`;
          return (
            <button key={key} className={`direct-conversation-row ${activeKey === key ? "selected" : ""}`} onClick={() => onOpen(item)}>
              <span className={`direct-avatar ${item.peerType}`} style={{ background: item.color }}>{item.title.slice(0, 1).toUpperCase()}</span>
              <span className="direct-row-copy"><strong>{item.title}</strong><small>{item.preview}</small></span>
              <span className="direct-row-meta"><time>{timeLabel(item.updatedAt)}</time><em>{item.peerType === "agent" ? "Agent" : t("好友", "Person")}</em></span>
            </button>
          );
        })}
        {visible.length === 0 && <div className="direct-list-empty">{t("没有匹配的对话", "No matching conversations")}</div>}
      </div>
    </aside>
  );
}

export function HumanDirectChat({
  peer,
  currentUser,
  onError,
  onSent,
}: {
  peer: DirectConversationSummary;
  currentUser: User;
  onError: (message: string) => void;
  onSent: () => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<HumanDirectMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.humanDirectMessages(peer.peerId)
      .then((result) => { if (!cancelled) setMessages(result.messages); })
      .catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError, peer.peerId]);
  useLayoutEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const content = draft.trim();
    setDraft("");
    setBusy(true);
    try {
      const result = await api.sendHumanDirectMessage(peer.peerId, content);
      setMessages((current) => [...current, result.message]);
      onSent();
    } catch (reason) {
      setDraft(content);
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="human-direct-chat">
      <header><div><h1>{peer.title}</h1><span>{peer.subtitle}</span></div><em>{t("私人对话", "Private conversation")}</em></header>
      <div className="human-direct-messages">
        {loading ? <div className="direct-chat-empty">{t("正在载入…", "Loading…")}</div> : messages.length === 0 ? <div className="direct-chat-empty"><span>{peer.title.slice(0, 1)}</span><h2>{t(`开始与 ${peer.title} 聊天`, `Start a conversation with ${peer.title}`)}</h2><p>{t("这里的消息仅对你们两人可见。", "Messages here are visible only to the two of you.")}</p></div> : messages.map((message) => {
          const own = message.senderUserId === currentUser.id;
          return <article key={message.id} className={`human-direct-message ${own ? "own" : "peer"}`}><div><strong>{own ? t("你", "You") : peer.title}</strong><time>{timeLabel(message.createdAt)}</time></div><p>{message.content}</p></article>;
        })}
        <div ref={end} />
      </div>
      <form className="human-direct-composer" onSubmit={send}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t(`发送给 ${peer.title}`, `Message ${peer.title}`)} rows={3} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div><span>{t("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line")}</span><button className="send-button" disabled={!draft.trim() || busy}>↑</button></div>
      </form>
    </section>
  );
}
