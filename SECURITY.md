# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the exact revision
linked by the current submission is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Seeded local accounts and opaque server sessions, not production registration,
  account recovery, MFA, or an external identity provider
- Group roles and protected-resource authorization are implemented, but the JSON
  store is single-process and is not a production tenant-isolation boundary
- `SameSite=Strict` session cookies are used, but there is no separate CSRF token
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- The configured model API key is available to the trusted server and the active,
  disposable Runtime container for the duration of a model call
- Authorization decisions are append-only in the POC data model, but the local
  operator can still modify or delete the backing JSON file

## Implemented controls

- Human identity is derived from an opaque `HttpOnly`, `SameSite=Strict` session;
  request bodies cannot replace it.
- Every Agent is a separate principal. Protected Runtime calls require an opaque,
  short-lived credential bound to the human, Agent, Run, conversation, and task.
- Private-catalog metadata, `read`, sealed `process`, raw `disclose`, and external
  `forward` are separate server-side decisions. The default Runtime context does
  not expose private-catalog existence. Exact missing and inaccessible references
  fail identically, and free-form text can create only a pending owner request.
- Run and task grants are scoped and revocable. Runtime credentials are stored only
  as hashes and removed when execution ends.
- Authorization details are deterministically redacted before storage. Runtime tool
  observations omit command arguments, protected output, and credentials.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable model key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide cloud-account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
