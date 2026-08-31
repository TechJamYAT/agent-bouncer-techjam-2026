# Protected-resource flow (authoritative text)

This document is the text source of truth for the Bouncer demo. Diagrams and
PDFs should be regenerated only after this flow is accepted.

## Core rule

The Agent decides which protected operation is needed next, but the trusted
backend decides whether that operation is allowed. Agent prose is never proof of
an access request, approval, read, disclosure, or delivery. A Run may complete
only after the required Run-linked backend evidence exists.

## Flow matrix

| User request | Target attached to this Run? | Required backend stages |
| --- | --- | --- |
| List the user's private files | No | catalog request → owner approval → metadata-only list |
| Summarize/read one private file | Yes, exact target | attachment-bound read → answer |
| Summarize/read one private file | No | catalog request → approval → exact read request → approval → read → answer |
| Quote/show the raw source | Yes, exact target | exact disclosure request → approval → disclose in current conversation |
| Quote/show the raw source | No | catalog request → approval → exact disclosure request → approval → disclose |
| Forward the user's file | Yes, exact target | exact resource-and-recipient forward request → approval → backend delivery |
| Forward the user's file | No | catalog request → approval → exact resource-and-recipient forward request → approval → backend delivery |
| Forward another owner's file | Either | real forward call → backend `CROSS_OWNER_FORWARD_DENIED`; no approvable card |

An attachment grants read access only to that exact attached resource for the
current Run. It does not grant catalog access, disclosure, forwarding, access to
another file, or access in a later Run.

If file A is attached but the task also requires file B, B follows the complete
unattached flow. Catalog approval reveals only titles, kinds, and creation times;
it never grants content access.

## Approval lifecycle

1. The Agent calls a protected tool, or the control plane detects a clear
   protected intent that the Agent only described in prose.
2. The backend records the policy decision, persists an action-specific request,
   and atomically sets the Run to `waiting_for_approval`.
3. Approval, rejection, or timeout destroys the old Runtime credential.
4. Approval resumes the same logical Run exactly once with a fresh credential.
5. The final protected action must produce its own `ALLOW` evidence. An approval
   record by itself is not fulfillment.
6. If the resumed Agent skips the exact approved action, the trusted control
   plane deterministically performs only that approved operation and gives the
   bounded result to a follow-up Agent turn.
7. Rejection and timeout resume without protected content. Completion revokes
   remaining Run-scoped credentials and capabilities.

## Evidence examples

```text
resource:list       ALLOW  PRIVATE_CATALOG_METADATA_APPROVED
resource:read       ALLOW  TASK_SCOPED_GRANT
resource:disclose   ALLOW  DISCLOSURE_RECIPIENT_APPROVED
resource:forward    ALLOW  USER_INTENT_BOUND_FORWARD
resource:forward    DENY   CROSS_OWNER_FORWARD_DENIED
```

The raw protected body is returned to Runtime only for an approved read or
current-conversation disclosure. External forwarding is performed directly by
the control plane; Runtime receives a receipt without the body.
