/**
 * PUBLIC (unauthenticated) delivery tracking. Mounted at /track — a requestor
 * shares /track/<token> with their own customer. The token is HMAC-signed over
 * the trip id (lib/trackingToken), so links can't be enumerated. Exposes ONLY
 * non-sensitive status: ticket, a coarse status label, progress, and the
 * destination AREA — never the driver, phone, full address, or any money.
 */
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { verifyTrackingToken } from "../lib/trackingToken";
import { UWC_LOGO_PNG } from "../lib/uwcLogo";

const router = Router();

const STATUS_LABEL: Record<string, string> = {
  pending: "Awaiting dispatch",
  approved: "Awaiting dispatch",
  assigned: "Driver assigned",
  in_progress: "In transit",
  pending_approval: "Delivered",
  completed: "Delivered",
  cancelled: "Cancelled",
  rejected: "Cancelled",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function html(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Track delivery</title><style>
    :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    body{margin:0;background:#f1f5f9;color:#0f172a;display:flex;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:440px;width:100%;padding:24px}
    .brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700}
    .ticket{font-size:22px;font-weight:800;margin:6px 0 16px}
    .status{display:inline-block;padding:6px 14px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-weight:700;font-size:15px}
    .status.done{background:#dcfce7;color:#15803d}.status.off{background:#fee2e2;color:#b91c1c}
    .row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:15px}
    .row:last-child{border-bottom:0}.muted{color:#64748b}
    .foot{margin-top:16px;font-size:12px;color:#94a3b8}
    .logo{height:52px;width:auto;display:block;margin:0 auto 16px}
  </style></head><body><div class="card"><img class="logo" src="/track/logo.png" alt="UWC Berhad">${inner}</div></body></html>`;
}

// The tracking-page logo — served same-origin (helmet img-src 'self') and
// cached hard since it never changes. Declared before "/:token" so the literal
// "logo.png" isn't captured as a token.
router.get("/logo.png", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.type("png").send(UWC_LOGO_PNG);
});

router.get("/:token", async (req, res) => {
  const tripId = verifyTrackingToken(req.params.token);
  const notFound = () =>
    res.status(404).type("html").send(html(`<div class="brand">UWC Delivery</div><h1>Not found</h1><p class="muted">This tracking link is invalid or has expired.</p>`));

  if (!tripId) return notFound();
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      ticket_number: true,
      status: true,
      stops: { orderBy: { sequence: "asc" }, select: { status: true, consignee: { select: { area: true } } } },
    },
  });
  if (!trip) return notFound();

  const delivered = trip.stops.filter((s) => s.status === "delivered").length;
  const total = trip.stops.length;
  const label = STATUS_LABEL[trip.status] ?? trip.status;
  const cls = label === "Delivered" ? "status done" : label === "Cancelled" ? "status off" : "status";
  const areas = [...new Set(trip.stops.map((s) => s.consignee.area).filter(Boolean))].join(", ");

  res.type("html").send(
    html(
      `<div class="brand">UWC Delivery</div>` +
        `<div class="ticket">${esc(trip.ticket_number)}</div>` +
        `<span class="${cls}">${esc(label)}</span>` +
        `<div class="row"><span class="muted">Stops delivered</span><span>${delivered} / ${total}</span></div>` +
        (areas ? `<div class="row"><span class="muted">Destination</span><span>${esc(areas)}</span></div>` : "") +
        `<div class="foot">Live delivery status · UWC Berhad</div>`
    )
  );
});

export default router;
