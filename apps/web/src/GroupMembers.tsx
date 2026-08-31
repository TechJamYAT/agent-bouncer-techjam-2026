import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import type { Group, GroupMember, User } from "./types";

interface GroupMembersProps {
  group: Group;
  currentUser: User;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}

export function GroupMembers({ group, currentUser, onChanged, onError }: GroupMembersProps) {
  const { t } = useI18n();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const canManage = group.role === "owner" || group.role === "admin";

  const refresh = useCallback(async () => {
    const [memberResult, userResult] = await Promise.all([
      api.groupMembers(group.id),
      api.users(),
    ]);
    setMembers(memberResult.members);
    setUsers(userResult.users);
  }, [group.id]);

  useEffect(() => {
    void refresh().catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)));
  }, [onError, refresh]);

  const candidates = useMemo(
    () => users.filter((user) => !members.some((member) => member.user.id === user.id)),
    [members, users],
  );

  useEffect(() => {
    if (!candidates.some((user) => user.id === selectedUserId)) {
      setSelectedUserId(candidates[0]?.id ?? "");
    }
  }, [candidates, selectedUserId]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedUserId) return;
    setBusy(true);
    try {
      await api.addGroupMember(group.id, selectedUserId, role);
      await Promise.all([refresh(), onChanged()]);
      setInviteOpen(false);
      setRole("member");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: GroupMember) => {
    if (!window.confirm(t(`将 ${member.user.displayName} 移出 ${group.name}？`, `Remove ${member.user.displayName} from ${group.name}?`))) return;
    setBusy(true);
    try {
      await api.removeGroupMember(group.id, member.user.id);
      await Promise.all([refresh(), onChanged()]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="members-panel">
      <header><div><h2>{t("群组成员", "Group members")}</h2><p>{t(`${members.length} 位成员可以查看群聊、任务和群组资源。`, `${members.length} members can view group chat, tasks, and group resources.`)}</p></div></header>
      {inviteOpen && (
        <form className="invite-member-form" onSubmit={invite}>
          <label>{t("平台用户", "Platform user")}<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={candidates.length === 0}>{candidates.map((user) => <option value={user.id} key={user.id}>{user.displayName} · @{user.username}</option>)}</select></label>
          <label>{t("群组角色", "Group role")}<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "member")}><option value="member">{t("成员", "Member")}</option><option value="admin">{t("管理员", "Admin")}</option></select></label>
          <button className="button button-primary" disabled={busy || !selectedUserId}>{busy ? t("添加中…", "Adding…") : t("确认添加", "Add member")}</button>
          {candidates.length === 0 && <small>{t("所有平台用户都已经在这个群里。", "All platform users are already in this group.")}</small>}
        </form>
      )}
      <div className="member-list">
        {canManage && <button className="member-invite-card" onClick={() => setInviteOpen((value) => !value)}><span>＋</span><div><strong>{t("邀请成员", "Invite member")}</strong><small>{t("将平台用户加入当前群组", "Add a platform user to this group")}</small></div></button>}
        {members.map((member) => (
          <article key={member.user.id}>
            <span>{member.user.displayName.slice(0, 1).toUpperCase()}</span>
            <div><strong>{member.user.displayName}{member.user.id === currentUser.id ? t("（你）", " (you)") : ""}</strong><small>@{member.user.username}</small></div>
            <em className={`member-role role-${member.role}`}>{member.role === "owner" ? t("群主", "Owner") : member.role === "admin" ? t("管理员", "Admin") : t("成员", "Member")}</em>
            {canManage && member.role !== "owner" && member.user.id !== currentUser.id && <button className="member-remove" onClick={() => void remove(member)} disabled={busy}>{t("移除", "Remove")}</button>}
          </article>
        ))}
      </div>
    </section>
  );
}
