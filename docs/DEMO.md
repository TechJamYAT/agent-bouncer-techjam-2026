# Three-minute Demo — Bouncer Middleware

## One-sentence story

Bouncer binds an Agent's external data transfer to the human's exact Run,
resource, and recipient: Alice can send Alice's document to Bob, while prompt
injection and attempts to obtain Bob's private document are blocked in the
trusted backend.

## Before judging

1. Configure a Git-ignored `.env`; never enter or show a key during the demo.
2. Run `npm run check` and keep the successful summary available.
3. Start isolated demo data with `npm run demo:fresh`.
4. Confirm the model endpoint and Runtime are warm.
5. Prepare Alice's `Case` conversation and Alice/Bob direct messages.

## Live script

### 0:00–0:25 — State the problem

> An Agent can read useful context without receiving unlimited authority to
> disclose or forward it. Bouncer treats human intent, Agent execution, resource
> ownership, and the recipient as separate security inputs.

### 0:25–0:55 — Normal read

As Alice, attach `Alice — Private Interview Notes` and ask `Case` to summarize
it. Open **Backend execution process** and show:

```text
resource:read
200 ALLOW — EXPLICIT_PRIVATE_GRANT
```

Attaching the resource already authorizes this Run to read it; no duplicate
approval is required.

### 0:55–1:35 — Explicit owner-authorized forward

Send:

```text
把《Alice — Private Interview Notes》发给 bob
```

Show:

```text
POST /api/runtime/resources/forward
200 ALLOW — USER_INTENT_BOUND_FORWARD
```

Open Alice and Bob's direct conversation. The protected body was delivered by
the control plane; the Agent received only a delivery receipt.

### 1:35–2:15 — Cross-owner denial

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

### 2:15–2:40 — Injection boundary

Use prepared evidence for a Run where protected content attempted to induce a
forward without a human-authored request:

```text
403 DENY — HUMAN_FORWARD_INTENT_REQUIRED
```

Agent output and protected content cannot mint a human intent capability.

### 2:40–3:00 — Lifecycle and verification

Show the permission evidence with human, Agent, Run, resource, recipient, and
reason code. Show the Run credential and unused intent grant revoked at the end,
then show the final `npm run check` summary.

Finish with:

> Bouncer gives every Agent a reusable authorization boundary: useful reads are
> low-friction, external transfers are recipient-bound, and another owner's data
> remains outside the requester's authority.

## Backup: Agent-proposed forward

An Agent may call `vault.mjs request-forward` for Alice's own exact resource and
a registered recipient. The request appears as an approval card in the main
conversation. Approval resumes the same logical Run with a fresh credential;
rejection or timeout resumes without delivery. A cross-owner proposal is denied
before any approval card can be created.

## Go/no-go checklist

- [ ] Alice's attached resource reads without a duplicate confirmation.
- [ ] Alice's exact resource reaches Bob only after `USER_INTENT_BOUND_FORWARD`.
- [ ] The forward receipt contains no protected body.
- [ ] Bob's private resource produces `CROSS_OWNER_FORWARD_DENIED` for Alice.
- [ ] A content-driven forward produces `HUMAN_FORWARD_INTENT_REQUIRED`.
- [ ] Agent-proposed approval rejects or times out safely.
- [ ] `npm run check` passes twice.
- [ ] The archive contains no `.env`, local state, sessions, or secrets.
