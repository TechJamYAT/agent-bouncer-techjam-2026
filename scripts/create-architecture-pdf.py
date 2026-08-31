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


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(OUTPUT), pagesize=PAGE)
    width, height = PAGE

    c.setFillColor(PAPER)
    c.rect(0, 0, width, height, fill=1, stroke=0)

    text(c, "AGENT LAUNCHPAD / BOUNCER MIDDLEWARE", 38, 505, 7, PURPLE, "Helvetica-Bold")
    text(c, "Read with context. Forward with intent.", 38, 468, 25, INK, "Helvetica-Bold")
    text(
        c,
        "A recipient-bound authorization boundary for agents acting on behalf of humans.",
        38,
        445,
        10,
        MUTED,
    )

    pill(c, "HUMAN != AGENT", 710, 476, PURPLE_LIGHT, PURPLE)
    pill(c, "RUN-BOUND", 819, 476, GREEN_LIGHT, GREEN)
    pill(c, "REDACTED", 819, 449, RED_LIGHT, RED)

    # Trust zones.
    rounded_box(c, 30, 115, 205, 285, HexColor("#F4F1FA"), HexColor("#D9D1EA"), 16)
    rounded_box(c, 255, 115, 450, 285, white, HexColor("#CFC7DD"), 16)
    rounded_box(c, 725, 115, 205, 285, HexColor("#F7F5F1"), HexColor("#DCD7CF"), 16)

    text(c, "UNTRUSTED CLIENT", 47, 378, 7, PURPLE, "Helvetica-Bold")
    text(c, "TRUSTED CONTROL PLANE", 272, 378, 7, PURPLE, "Helvetica-Bold")
    text(c, "UNTRUSTED RUNTIME", 742, 378, 7, PURPLE, "Helvetica-Bold")

    component(c, 48, 270, 169, 78, "Human session", "Alice", "HttpOnly session -> human principal", white)
    component(c, 48, 158, 169, 78, "Evidence UI", "Run trace", "Displays decisions, never secrets", white)

    component(c, 275, 285, 180, 64, "Request boundary", "Fastify API", "Validates session and Runtime token", PURPLE_LIGHT)
    component(c, 505, 285, 180, 64, "Run orchestration", "AgentService", "Binds human + Agent + Run + recipient", PURPLE_LIGHT)
    component(c, 275, 170, 180, 76, "Enforcement point", "Bouncer policy", "read / forward / approve", white)
    component(c, 505, 170, 180, 76, "Durable evidence", "Decision store", "actor + action + target + reason", white)

    component(c, 744, 285, 167, 64, "Agent principal", "Case Runtime", "Short-lived scoped credential", RUNTIME)
    text(c, "Case Runtime", 758, 313, 12, white, "Helvetica-Bold")
    text(c, "Short-lived scoped credential", 758, 298, 7.5, HexColor("#D8D2E4"))
    component(c, 744, 170, 167, 76, "Protected tool", "vault.mjs", "read / forward / request", white)

    # Main request path.
    arrow(c, 217, 309, 275, 317)
    arrow(c, 455, 317, 505, 317)
    arrow(c, 685, 317, 744, 317)
    arrow(c, 827, 285, 827, 246)
    c.setStrokeColor(PURPLE)
    c.setLineWidth(2)
    c.line(744, 208, 716, 208)
    c.line(716, 208, 716, 260)
    c.line(716, 260, 365, 260)
    arrow(c, 365, 260, 365, 246)
    arrow(c, 455, 194, 505, 194)
    arrow(c, 505, 181, 455, 181, HexColor("#A69CB5"), 1.5)
    arrow(c, 275, 185, 217, 191, HexColor("#A69CB5"), 1.5)

    # Outcome strip.
    rounded_box(c, 30, 42, 900, 52, INK, INK, 13)
    pill(c, "1  READ", 48, 59, GREEN_LIGHT, GREEN)
    text(c, "ALLOW", 151, 65, 10, HexColor("#78D7AA"), "Helvetica-Bold")
    text(c, "Attached owner resource", 205, 65, 8, HexColor("#D8D2E4"))
    text(c, "+", 348, 65, 12, white, "Helvetica-Bold")
    pill(c, "2  FORWARD", 376, 59, GREEN_LIGHT, GREEN)
    text(c, "ALLOW", 488, 65, 10, HexColor("#78D7AA"), "Helvetica-Bold")
    text(c, "Exact human intent", 540, 65, 8, HexColor("#D8D2E4"))
    pill(c, "3  CROSS-OWNER", 680, 59, RED_LIGHT, RED)
    text(c, "DENY", 813, 65, 10, HexColor("#EF827B"), "Helvetica-Bold")
    text(c, "no approval", 858, 65, 7, HexColor("#D8D2E4"))

    text(c, "Fail closed: Agent output and protected content cannot create a human forward intent.", 38, 15, 7.5, MUTED)
    text(c, "POC boundary: local JSON store + disposable container; not production tenant isolation.", 604, 15, 7.5, MUTED)

    c.showPage()
    c.save()


if __name__ == "__main__":
    build()
