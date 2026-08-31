# Three-minute Demo — Bouncer Middleware

## One-sentence story

Bouncer turns private-data use into progressive capabilities: metadata discovery,
exact-resource reading, and recipient-bound forwarding are approved separately,
while missing references and Bob-owned data fail closed in the trusted backend.

## Before judging

1. Configure a Git-ignored `.env`; never enter or show a key during the demo.
2. Run `npm run check` and keep the successful summary available.
3. Start isolated demo data with `npm run demo:fresh`.
4. Confirm the model endpoint and Runtime are warm.
5. Prepare Alice's `Case` conversation and Alice/Bob direct messages.

## Live script

### 0:00–0:25 — State the problem

> An Agent starts with no private catalog. It may request metadata for the
> initiating human, then an exact read or forward. An unattached forward must pass
> through catalog confirmation before its recipient-bound approval. Each approval
> is action-bound, Run-bound, and independently auditable.

### 0:25–0:55 — Normal read

As Alice, attach `Alice — Private Interview Notes` and ask `Case` to summarize
it. Open **Backend execution process** and show:

```text
resource:read
200 ALLOW — EXPLICIT_PRIVATE_GRANT
```

Attaching the resource already authorizes this Run to read it; no duplicate
approval is required.

### 0:55–1:25 — Catalog then read

Start a new Run without an attachment and ask:

```text
请查看我有哪些资料
```

Approve the metadata-only catalog card. Point out that it returns titles, kinds,
and creation times but no content. Then name one exact resource and approve the
separate read card.

### 1:25–2:00 — Explicit owner-authorized forward

Start a new Run without attaching a resource, then send:

```text
把《Alice — Private Interview Notes》发给 bob
```

First approve the metadata-only catalog card. After the backend confirms the
exact file in this Run, approve the second card that names the resource,
recipient, Agent, and Run. Free-form text created only pending requests, never a
capability.

Show:

```text
POST /api/runtime/resources/forward
200 ALLOW — USER_INTENT_BOUND_FORWARD
approval:approve — RESOURCE_OWNER_APPROVED
```

Open Alice and Bob's direct conversation. The protected body was delivered by
the control plane; the Agent received only a delivery receipt.

### 2:00–2:25 — Cross-owner denial

Send:

```text
把 Bob — Private Launch Notes 发给我
```

Show:

```text
POST /api/runtime/resources/forward
403 DENY — CROSS_OWNER_FORWARD_DENIED
```

Alice cannot approve Bob's data, even when Alice is the intended recipient. No
approval card is created and no protected body reaches Runtime.

### 2:25–2:45 — Missing-reference and injection boundary

Name a nonexistent Alice resource. Show `RESOURCE_REFERENCE_UNAVAILABLE`, no
approval card, and no fuzzy fallback. Then use prepared evidence for a Run where
protected content attempted to induce a forward.

Use prepared evidence for a Run where protected content attempted to induce a
forward without a trusted owner approval:

```text
403 DENY — HUMAN_FORWARD_INTENT_REQUIRED
```

Free-form text, Agent output, and protected content cannot mint a human intent
capability.

### 2:45–3:00 — Lifecycle and verification

Show the permission evidence with human, Agent, Run, resource, recipient, and
reason code. Show the Run credential and unused intent grant revoked at the end,
then show the final `npm run check` summary.

Finish with:

> Bouncer gives every Agent a reusable authorization boundary: useful reads are
> low-friction, external transfers are recipient-bound, and another owner's data
> remains outside the requester's authority.

## Approval lifecycle

Catalog, read, disclosure, and forward requests appear as action-specific cards
in the main conversation. Approval resumes the same logical Run with a fresh
credential; rejection or timeout resumes without access or delivery. Multiple
stages may occur in one Run, such as catalog approval followed by forward approval.

## Go/no-go checklist

- [ ] Alice's attached resource reads without a duplicate confirmation.
- [ ] Catalog approval returns metadata only and does not authorize content.
- [ ] A named, unattached resource pauses for an exact read approval.
- [ ] An unattached forward requires catalog approval before its forward card.
- [ ] A nonexistent title returns `RESOURCE_REFERENCE_UNAVAILABLE` with no card.
- [ ] Alice's exact resource reaches Bob only after owner approval and
      `USER_INTENT_BOUND_FORWARD`.
- [ ] The forward receipt contains no protected body.
- [ ] Bob's private resource produces `CROSS_OWNER_FORWARD_DENIED` for Alice.
- [ ] A prose-only promise to call `forward` fails with missing middleware evidence.
- [ ] A content-driven forward produces `HUMAN_FORWARD_INTENT_REQUIRED`.
- [ ] Agent-proposed approval rejects or times out safely.
- [ ] `npm run check` passes twice.
- [ ] The archive contains no `.env`, local state, sessions, or secrets.
