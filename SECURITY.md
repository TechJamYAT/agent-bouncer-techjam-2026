# Security policy

Agent Launchpad is a hackathon proof of concept. Only the latest revision on
the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Implemented safeguards

- The server derives the current human from an opaque `HttpOnly`,
  `SameSite=Strict` session instead of trusting a browser-supplied user ID.
- Human and Agent principals are distinct, and protected resources are checked
  at a shared backend policy boundary.
- Runtime credentials are short-lived, scoped to one Run, stored as hashes, and
  revoked when execution ends.
- Authorization decisions are correlated to the human, Agent, action, resource,
  and Run/task; sensitive audit details are deterministically redacted.
- Local Agent turns run in disposable containers with bounded resources and
  dropped capabilities.
- Request logging redacts authorization, cookie, and session response headers.

## Known limitations

- Seeded demo users share a documented demo password. There is no registration,
  MFA, account recovery, rate limiting, or production identity provider.
- There is no separate CSRF token. The POC relies on `SameSite=Strict` cookies,
  same-origin production requests, and restricted development CORS.
- JSON persistence is single-process and does not provide database transactions,
  multi-node consistency, or durable idempotency guarantees.
- Failed task file changes are not checkpointed or rolled back.
- ECS mode has no per-Agent container boundary. Local containers are ordinary
  containers, not hardened multi-tenant sandboxes or microVMs.
- Runtime containers have broad outbound network access and support
  prompt-triggered command and file execution inside the assigned workspace.
- The model API key is available to the server and the active Runtime container;
  Terraform POC state can contain deployment secrets.

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable model key and a unique `APP_AUTH_TOKEN` for any
  non-loopback deployment.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
