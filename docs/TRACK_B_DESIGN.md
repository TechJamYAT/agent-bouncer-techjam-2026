# Track B Design — Policy-Aware Personal and Group Agents

## Competition declaration

This project selects one coherent middleware story: **Bouncer identity and
authorization**.
It separates the initiating human from the Agent acting for that human and
enforces resource ownership in the server and Runtime path. Authorization
decision records make the selected middleware understandable; they are not a
claim to a second track.

## Product statement

People can create personal Agents and group-owned role Agents. Group Agents can
collaborate through a guided task, but collaboration never erases the human,
Agent, group, conversation, or resource boundary.

## Delivery tiers

### P0 — required Track B path

- Real server-side sessions for five seeded demo users.
- Dynamic groups with `owner`, `admin`, and `member` roles.
- A distinct non-human principal for every personal and group Agent.
- Private and group text resources.
- Explicit private-resource grants and immediate revocation.
- A central resource policy used by every protected knowledge-read route.
- Progressive catalog, exact read, and recipient-bound forward requests; only a
  trusted owner approval can mint the action-specific Run capability. Unattached
  forwards require catalog confirmation before the forward request.
- Correlated authorization decisions containing the human, Agent, action,
  resource, result, reason, and request context.
- The exact required demo: Alice's personal Agent reads an Alice resource after
  consent and is denied access to Bob's private resource.
- Negative tests proving that changing IDs in a request does not change the
  server-derived human or Agent identity.

### P1 — product differentiator

- Agent direct messages, group chat, and a dedicated guided-task workspace.
- One optional system coordinator per group.
- Any number of same-group business Agents may participate; the platform does
  not impose an arbitrary Agent-count limit.
- Ordered execution in either manual or automatic mode, with replanning of only
  the unfinished work after new human input.
- A separate Task Workspace shared only by Agents selected for that task.
- Same-group collaboration, cross-group denial, task-scoped private grants,
  and automatic grant expiry.

### P2 — conditional enhancements

- Extend the implemented task context import (`none`, `full`, or selected
  same-group messages) to newly created Agent direct-message threads.
- Project file tree, bounded code view, and source ZIP download (implemented).
- Static preview, then a disposable local-container runner only if P0 and P1
  are already stable.

## Seeded demonstration identities

The data model supports arbitrary users. The local demo seeds five accounts:

| User | Alpha | Beta |
| --- | --- | --- |
| Alice | owner | — |
| Bob | member | owner |
| Carol | member | — |
| David | — | member |
| Emma | — | — |

Bob's membership in both groups is deliberate: an Alpha Agent must still be
denied access to Beta resources even when Bob initiates the Run.

## Principal model

### Human principal

The server derives the current human from an opaque, expiring session stored in
an `HttpOnly`, `SameSite=Strict` cookie. Request bodies and query parameters are
never accepted as proof of human identity.

### Agent principal

Every Agent is a distinct non-human principal with exactly one scope:

- `personal`: owned by one human and never transferred.
- `group`: owned by exactly one group and created by that group's owner/admin.
- `coordinator`: one system-managed, optional coordinator owned by one group.

Role names and instructions are untrusted behavioural configuration. Calling an
Agent "admin" never grants authority.

An Agent never owns a filesystem or a Runtime thread. Personal users and groups
own top-level Workspaces containing `shared/` and `projects/`. A Runtime session
is keyed by `(agentId, conversationId)`, so two humans privately using the same
group Agent never reuse hidden model state.

### Run principal

Every protected tool call is tied to the executing `agentId`, `runId`, and
initiating `humanId`. The Runtime receives a short-lived, scoped credential;
the resource service resolves ownership and grants from server-side state.

## Resource model

Protected platform resources are:

- `document`: human-authored text.
- `message`: a private, group, or task conversation message.
- `task_artifact`: an Agent-created task result.
- `project_workspace`: an Agent-created directory tree owned by a personal
  conversation or group task.

Every resource records its scope (`private` or `group`), owner, group
when relevant, creator principal, and timestamps.

The protected resource store is separate from the Codex Runtime mount. A
protected document is never exposed merely by placing it in every Agent
workspace.

## Policy matrix

The protected-data actions in the competition version are metadata-only private
catalog access, `read`, sealed `process`, raw current-conversation `disclose`,
and external `forward`. Resource
creation remains a human or task-artifact lifecycle operation. Agents cannot
edit or delete human-authored source documents.

| Executing principal | Own private read | Other private read | Own-group read | Other-group read |
| --- | --- | --- | --- | --- |
| Personal Agent | allow only with owner grant | always deny | deny | deny |
| Group Agent | n/a | allow only for a current group member with a Run/task-scoped grant | allow | always deny |
| Coordinator | deny | deny | task artifacts only; document contents denied | always deny |

Additional invariants:

- The initiating human must own a personal Agent before using it.
- The initiating human must be a current member before viewing or using a group
  Agent.
- A human's membership in another group is never inherited by the executing
  Agent.
- A personal Agent can never read another human's private resource, even if a
  request ID is tampered with.
- A group Agent can receive a private grant only from a current member of that
  same group and only for one Run or one task.
- Agent messages can be created only in the conversation that invoked or
  scheduled that Agent.
- Private-catalog existence is absent from default Agent context. Only the
  initiating human can approve metadata-only access to their own catalog for the
  current Run; this approval never grants content access.
- Exact resource names are blindly resolved. Missing, inaccessible, and
  nonexistent references have the same Runtime-facing response and never trigger
  fuzzy fallback or an approval for an arbitrary resource.
- External transfer requires an authenticated human to confirm one exact owned
  private resource and one distinct registered recipient. If the resource was not
  attached, the current Run must first obtain metadata-only catalog approval and
  confirm the file. The capability is Run-bound, one-time, and cannot be created
  from chat text, Agent output, or protected content.

## Human resource management

| Scope | Create | Edit/delete | Publish/change scope |
| --- | --- | --- | --- |
| Private | any human | owner | owner with confirmation |
| Group | any member | creator; owner/admin for all | owner/admin with confirmation |
| Task artifact | scheduled Agent | later task Agents may change task files | task initiator chooses whether to save to group resources |

Agents never publish resources or widen their own grants.

## Conversation boundaries

- Direct message: visible only to the human and selected Agent.
- Group chat: visible to current group members; same-group Agents may be
  mentioned directly or selected by the coordinator, and a group admin may mute
  an Agent without deleting it.
- Guided task: a separate task workspace linked from the group. Members can read
  and suggest; only the initiating human can approve, advance, replan, or stop.

Each conversation and task uses independent Codex session state. A task sees
explicitly attached messages and task artifacts, never another Agent's full
thread.

Each Run receives a server-authenticated conversation descriptor identifying
whether it is a personal Agent DM, private group-Agent DM, group chat, or group
task. A group task owns one project directory shared by its selected Agents;
ordinary DMs and group chat use isolated internal Runtime directories unless a
project is explicitly attached.

Immediately before invoking an Agent, the server atomically replaces
`.launchpad/context.json`. This audit snapshot contains the actual human and
Agent principals, group metadata, current workspace capabilities, and only the
history allowed for that invocation. The server policy engine and scoped
Runtime credential remain authoritative; changing or deleting the snapshot
cannot widen access.

For every group Run, the server also replaces `.launchpad/group.json` from the
authoritative `groups`, `memberships`, `agents`, and `resources` records. It
contains the group identity, every current human member and role, every current
group Agent and status, the group knowledge index, and exact counts. This is the
complete roster snapshot for that Run. Conversation speakers are never used to
infer who or which Agent belongs to the group.

For a private group-Agent DM, the snapshot contains only that human's exact DM
history plus the latest same-group visible chat. It never contains another
member's Agent DM or another group's context. For a task/group-chat step, the
snapshot uses the step's immutable `contextThroughSequence`, so mid-run input
is not silently injected and the next step receives it only after replanning.

New group tasks can import none, selected messages, or the full current group
chat. The server checks both the human's right to read the source and the
target task's group boundary, then copies a fixed snapshot; cross-group import
is always denied. Equivalent explicit selection for new Agent direct-message
threads remains planned. A private Agent conversation is never silently
attached to a group task.

## Shared coordination state machine

Each group owns at most one system-managed coordinator, created lazily and
reused when a task enables it. A task creator can enable or disable coordination
for that task. Group chat response cycles and guided tasks use the same
event-sequenced coordination engine; a guided task is always started explicitly
by a user.

```text
active -> waiting_for_human -> running
   ^             |              |
   |             |              +-> waiting_for_human (manual)
   |             |              +-> active (automatic)
   |             |              +-> failed -> retry
   +-- replan <--+              +-> completed (task only)
   +--------------------------------> stopped
```

The coordinator returns a validated structured decision: continue with an
ordered next round, complete the task or current chat-response cycle, or wait
for human input. It can select a subset of enabled same-group Agents, runs in an isolated coordinator directory,
and cannot receive private grants or publish project files. The backend validates
group ownership, enabled status, and grants before every specialist step. A
selected Agent may suggest another role but cannot invoke another Agent directly.

In manual mode every specialist step pauses for the controlling human; the same
human action also authorizes the next coordinator evaluation. In automatic mode
the scheduler executes the current ordered round, asks the coordinator whether
the objective is complete, and starts a targeted next round when necessary.
Both modes give the next Agent every committed message that existed before its
invocation. New human input invalidates pending planning and forces a fresh
coordinator decision before another Agent starts. A six-round limit pauses the
task for human guidance instead of allowing an unbounded Agent loop.

Session versions and atomically assigned event sequence numbers prevent two
advance actions from starting the same step. Timeouts, retry, and stop are
safety controls on execution; they are not limits on the number of Agents a
group may create or select.

Task Workspace checkpoint/rollback is a planned hardening step. Currently all
selected Agents share the task directory and changes are retained for diagnosis
after failures; publication into owner-level shared files still requires a
separate approval.

Agents can write only inside the current task project. Owner-level `shared/`
files are exposed through a read-only Runtime tool. Publishing a task file
creates a hash-bound approval request; the task initiator must approve the exact
bytes before the server copies them into `shared/`. If the source changes, the
approval becomes unusable and a new request is required. Overwriting another
member's shared file additionally requires its original publisher or a group
owner/admin.

## Revocation

- Personal grants may be one Run or persistent until revoked.
- Group Agents may receive private grants only for one Run or one task.
- Task grants expire when the task completes or stops.
- Disabling an Agent invalidates its active credentials and stops new access.
- Removing a member immediately revokes group access and their grants, and
  pauses tasks they initiated.
- A removed member may read their old Agent DM transcript but cannot continue
  it. Past group messages and artifacts remain group-owned.

## Authorization decision contract

Every protected request records:

```text
decisionId
occurredAt
initiatingHumanId
executingAgentId (nullable for human-only actions)
runId / taskId / conversationId (when present)
action
targetType
targetId
decision: allow | deny
reasonCode
policyVersion
safe detail
```

Representative reason codes include:

- `PERSONAL_AGENT_OWNER_MISMATCH`
- `PRIVATE_GRANT_REQUIRED`
- `TASK_SCOPED_GRANT`
- `AGENT_GROUP_MISMATCH`
- `HUMAN_NOT_GROUP_MEMBER`
- `AGENT_DISABLED`
- `GRANT_EXPIRED`

Known secrets and credential-shaped values are deterministically redacted before
decision details are stored or returned to the UI. No model performs redaction.

## Required live evidence

The primary Track B demo is one evidence-gated allow-then-deny Run:

1. Alice creates a manual Alpha task, selects only group Agent `Case`, and
   enables the Bouncer evidence contract.
2. Bob grants `Case` task-scoped `process` access to his private launch notes.
3. `Case` calls the protected processor. The backend records
   `resource:process=allow / TASK_SCOPED_PROCESS_GRANT` and returns only an
   aggregate risk result.
4. `Case` requests disclosure to Alice. The backend records
   `resource:disclose=deny / PRIVATE_DISCLOSURE_RECIPIENT_DENIED` and returns no
   source content.
5. The Run completes only when both persisted decisions satisfy the contract.
   If the Agent skips either tool action, the Run and step fail and expose Retry.

The personal-Agent owner-mismatch and cross-group scenarios remain useful
backup demonstrations and automated regression cases.

Automated tests cover evidence-contract success and missing-action failure,
redacted Runtime tool observations, forged HTTP identity/Run/task fields, per-human Agent-DM
isolation, same-group visible history, task-participant grant binding, ordered
task context, cross-group resource denial, expired grants, and disabled Agents.
