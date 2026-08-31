from pathlib import Path

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "bouncer-architecture.pdf"
PAGE = landscape((960, 540))

INK = HexColor("#24212D")
MUTED = HexColor("#6F687B")
PURPLE = HexColor("#6654D9")
PURPLE_LIGHT = HexColor("#F0EDFF")
GREEN = HexColor("#2F9D72")
GREEN_LIGHT = HexColor("#E7F7EF")
RED = HexColor("#C6534D")
RED_LIGHT = HexColor("#FBEAE8")
LINE = HexColor("#DDD8E5")
PAPER = HexColor("#FBFAF7")
RUNTIME = HexColor("#35303F")


def rounded_box(c: Canvas, x: float, y: float, w: float, h: float, fill, stroke=LINE, radius=12):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(1)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def text(c: Canvas, value: str, x: float, y: float, size=10, color=INK, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, value)


def centered(c: Canvas, value: str, x: float, y: float, w: float, size=10, color=INK, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawCentredString(x + w / 2, y, value)


def pill(c: Canvas, value: str, x: float, y: float, fill, color, pad=9):
    width = stringWidth(value, "Helvetica-Bold", 7) + pad * 2
    c.setFillColor(fill)
    c.roundRect(x, y, width, 18, 9, fill=1, stroke=0)
    centered(c, value, x, y + 5.5, width, 7, color, "Helvetica-Bold")
    return width


def arrow(c: Canvas, x1: float, y1: float, x2: float, y2: float, color=PURPLE, width=2):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    if abs(x2 - x1) >= abs(y2 - y1):
        direction = 1 if x2 > x1 else -1
        c.line(x2, y2, x2 - 7 * direction, y2 + 4)
        c.line(x2, y2, x2 - 7 * direction, y2 - 4)
    else:
        direction = 1 if y2 > y1 else -1
        c.line(x2, y2, x2 - 4, y2 - 7 * direction)
        c.line(x2, y2, x2 + 4, y2 - 7 * direction)


def component(c: Canvas, x: float, y: float, w: float, h: float, eyebrow: str, title: str, detail: str, fill=white):
    rounded_box(c, x, y, w, h, fill)
    text(c, eyebrow.upper(), x + 14, y + h - 18, 6.5, PURPLE, "Helvetica-Bold")
    text(c, title, x + 14, y + h - 36, 12, INK, "Helvetica-Bold")
    text(c, detail, x + 14, y + 13, 7.5, MUTED)


def service_stack(c: Canvas, x: float, y: float, w: float, h: float):
    rounded_box(c, x, y, w, h, PURPLE_LIGHT)
    text(c, "EXTRACTED CONTROL-PLANE SERVICES", x + 14, y + h - 18, 6.5, PURPLE, "Helvetica-Bold")
    lines = [
        "PrincipalService - sessions, groups, and Agent lifecycle",
        "ProtectedResourceWorkflow - approval, timeout, resume, and final evidence",
        "RuntimeCredentialService - issue, validate, and revoke Run credentials",
        "RuntimeContext + Prompt Builders - authenticated bounded snapshots",
        "ModelRuntimeConfiguration - environment or in-memory provider setup",
    ]
    for index, value in enumerate(lines):
        text(c, value, x + 14, y + h - 34 - index * 11, 7.1, INK if index < 3 else MUTED)


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(OUTPUT), pagesize=PAGE)
    width, height = PAGE
    c.setTitle("Agent Launchpad - Bouncer Middleware Architecture")
    c.setAuthor("TikTok TechJam 2026 - Agent Bouncer")
    c.setSubject("Submission architecture and trusted execution flow")

    c.setFillColor(PAPER)
    c.rect(0, 0, width, height, fill=1, stroke=0)

    text(c, "AGENT LAUNCHPAD / BOUNCER MIDDLEWARE", 38, 505, 7, PURPLE, "Helvetica-Bold")
    text(c, "Trust the control plane, not the Agent.", 38, 468, 25, INK, "Helvetica-Bold")
    text(
        c,
        "Real Runtime calls, progressive owner approval, and Run-linked backend evidence.",
        38,
        445,
        10,
        MUTED,
    )

    pill(c, "HUMAN != AGENT", 710, 476, PURPLE_LIGHT, PURPLE)
    pill(c, "RUN-BOUND", 819, 476, GREEN_LIGHT, GREEN)
    pill(c, "BACKEND-ENFORCED", 785, 449, RED_LIGHT, RED)

    # Trust zones.
    rounded_box(c, 30, 105, 170, 305, HexColor("#F4F1FA"), HexColor("#D9D1EA"), 16)
    rounded_box(c, 215, 105, 490, 305, white, HexColor("#CFC7DD"), 16)
    rounded_box(c, 720, 155, 210, 255, HexColor("#F7F5F1"), HexColor("#DCD7CF"), 16)

    text(c, "UNTRUSTED CLIENT", 47, 388, 7, PURPLE, "Helvetica-Bold")
    text(c, "TRUSTED FASTIFY CONTROL PLANE / BOUNCER BOUNDARY", 232, 388, 7, PURPLE, "Helvetica-Bold")
    text(c, "UNTRUSTED AGENT RUNTIME", 737, 388, 7, PURPLE, "Helvetica-Bold")

    component(c, 48, 315, 134, 58, "Human session", "Alice", "HttpOnly human principal", white)
    component(c, 48, 235, 134, 58, "Client surface", "React Web UI", "Prompts + owner decisions", white)
    component(c, 48, 135, 134, 64, "Evidence UI", "Permission trace", "Run status + reason codes", white)

    component(c, 235, 320, 140, 58, "Request boundary", "Fastify API", "Human + Runtime endpoints", PURPLE_LIGHT)
    component(c, 405, 320, 155, 58, "Orchestration facade", "AgentService", "Binds human + Agent + Run", PURPLE_LIGHT)
    component(c, 590, 320, 95, 58, "State", "JSON store", "Runs + grants + audit", PURPLE_LIGHT)
    service_stack(c, 235, 220, 450, 82)
    component(c, 235, 130, 215, 68, "Enforcement point", "Gateway + policy", "catalog / read / process / disclose / forward", white)
    component(c, 470, 130, 215, 68, "Durable workflow evidence", "Approvals + decisions", "actor + action + target + reason + Run", white)

    rounded_box(c, 738, 320, 174, 58, RUNTIME)
    text(c, "RUNTIME ABSTRACTION", 752, 360, 6.5, PURPLE, "Helvetica-Bold")
    text(c, "AgentRunner", 752, 340, 12, white, "Helvetica-Bold")
    text(c, "Short-lived Run credential", 752, 327, 7.5, HexColor("#D8D2E4"))
    component(c, 738, 245, 174, 56, "Provider", "Codex CLI", "Disposable local container / ECS", white)
    component(c, 738, 170, 174, 56, "Bounded workspace", "Workspace + vault.mjs", "vault -> /api/runtime/*", white)
    component(c, 738, 95, 174, 58, "External service", "Model Responses API", "OpenAI-compatible: NUS / Ark / custom", HexColor("#F2EDFA"))

    # Main request path.
    arrow(c, 115, 315, 115, 293)
    arrow(c, 182, 264, 235, 349)
    arrow(c, 375, 349, 405, 349)
    arrow(c, 560, 349, 590, 349)
    c.setStrokeColor(PURPLE)
    c.setLineWidth(2)
    c.line(560, 334, 570, 310)
    c.line(570, 310, 720, 310)
    arrow(c, 720, 310, 738, 334)
    arrow(c, 825, 320, 825, 301)
    arrow(c, 825, 245, 825, 226)
    c.setStrokeColor(HexColor("#80652B"))
    c.setLineWidth(1.5)
    c.line(912, 273, 923, 273)
    c.line(923, 273, 923, 123)
    arrow(c, 923, 123, 912, 123, HexColor("#80652B"), 1.5)

    # Orchestration and protected-resource path.
    arrow(c, 482, 320, 482, 302)
    arrow(c, 460, 220, 342, 198)
    arrow(c, 450, 164, 470, 164)
    arrow(c, 577, 198, 577, 220, HexColor("#A69CB5"), 1.5)
    c.setStrokeColor(PURPLE)
    c.setLineWidth(2)
    c.line(738, 198, 710, 198)
    c.line(710, 198, 710, 115)
    c.line(710, 115, 342, 115)
    arrow(c, 342, 115, 342, 130)

    # Evidence projection back to the browser without crossing the policy cards.
    c.setStrokeColor(HexColor("#A69CB5"))
    c.setLineWidth(1.5)
    c.setDash(3, 2)
    c.line(637, 378, 637, 401)
    c.line(637, 401, 207, 401)
    c.line(207, 401, 207, 167)
    arrow(c, 207, 167, 182, 167, HexColor("#A69CB5"), 1.5)
    c.setDash()

    # Outcome strip.
    rounded_box(c, 30, 42, 900, 50, INK, INK, 13)
    pill(c, "1  ATTACHED", 46, 58, GREEN_LIGHT, GREEN)
    text(c, "ALLOW", 143, 64, 8.5, HexColor("#78D7AA"), "Helvetica-Bold")
    text(c, "exact Run read", 188, 64, 7.2, HexColor("#D8D2E4"))
    pill(c, "2  UNATTACHED", 274, 58, GREEN_LIGHT, GREEN)
    text(c, "APPROVE", 386, 64, 8.5, HexColor("#78D7AA"), "Helvetica-Bold")
    text(c, "catalog -> exact action", 447, 64, 7.2, HexColor("#D8D2E4"))
    pill(c, "3  FORWARD", 590, 58, GREEN_LIGHT, GREEN)
    text(c, "APPROVE", 683, 64, 8.5, HexColor("#78D7AA"), "Helvetica-Bold")
    text(c, "recipient-bound", 744, 64, 7.2, HexColor("#D8D2E4"))
    pill(c, "4  X-OWNER DENY", 815, 58, RED_LIGHT, RED)

    text(c, "Fail closed: Agent prose may request approval, but only trusted server state creates capability.", 38, 15, 7.2, MUTED)
    text(c, "Cross-owner transfer: DENY before any approvable card or protected delivery.", 614, 15, 7.2, MUTED)

    c.showPage()
    c.save()


if __name__ == "__main__":
    build()
