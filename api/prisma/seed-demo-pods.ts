/**
 * Attach clearly-SYNTHETIC proof-of-delivery photos to the demo instance's
 * delivered stops.
 *
 * WHY THIS EXISTS
 * ---------------
 * None of the seeds create a POD. seed.ts, seed-test.ts and seed-demo-trips.ts
 * between them produce users, consignees, trips and stops — but every
 * `pod_photo` is null, so on a freshly seeded instance the driver's POD screen
 * and the earnings screen render empty. That is fine for a test database and
 * wrong for a demo being shown to a judging panel.
 *
 * WHAT IT UPLOADS
 * ---------------
 * A generated placard reading "DEMO POD", the ticket number and the stop — NOT
 * a photograph of anything. It must be impossible to mistake for a real
 * delivery record, because the whole point of the demo instance is that nothing
 * on it is real. There is deliberately no option to upload a real image.
 *
 * It matches the app's own upload exactly (lib/cloudinary uploadBuffer, folder
 * "uwc/pod", type "authenticated", publicId "<ticket>-stop-<n>") so the demo
 * exercises the real signed-URL delivery path rather than a shortcut that would
 * look right and prove nothing.
 *
 * ⚠ Guarded. Writes only to a database the seed gate accepts (prisma/seedGate.ts):
 * a Railway target must be NAMED a demo database and have its host retyped via
 * CONFIRM_SEED_HOST. Production is unreachable.
 *
 * Run:
 *   DATABASE_URL=<demo> CONFIRM_SEED_HOST=<host> npx tsx prisma/seed-demo-pods.ts
 */
import { prisma } from "../src/lib/prisma";
import { uploadBuffer } from "../src/lib/cloudinary";
import { assertNotProduction } from "./destructive-guard";

/** A placard, not a photograph. Rasterised by Cloudinary on upload. */
function placardSvg(ticket: string, stopNo: number, consignee: string): Buffer {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <rect width="900" height="1200" fill="#0f1e3d"/>
  <rect x="40" y="40" width="820" height="1120" fill="none" stroke="#ffc72c" stroke-width="6" stroke-dasharray="24 16"/>
  <text x="450" y="330" font-family="Helvetica,Arial,sans-serif" font-size="120" font-weight="bold"
        fill="#ffc72c" text-anchor="middle">DEMO POD</text>
  <text x="450" y="430" font-family="Helvetica,Arial,sans-serif" font-size="42"
        fill="#ffffff" text-anchor="middle">SYNTHETIC — NOT A REAL DELIVERY</text>
  <line x1="140" y1="500" x2="760" y2="500" stroke="#3a4a6b" stroke-width="3"/>
  <text x="450" y="600" font-family="Helvetica,Arial,sans-serif" font-size="52"
        fill="#ffffff" text-anchor="middle">${esc(ticket)}</text>
  <text x="450" y="680" font-family="Helvetica,Arial,sans-serif" font-size="44"
        fill="#9aa5c4" text-anchor="middle">Stop ${stopNo}</text>
  <text x="450" y="760" font-family="Helvetica,Arial,sans-serif" font-size="36"
        fill="#9aa5c4" text-anchor="middle">${esc(consignee)}</text>
  <text x="450" y="1080" font-family="Helvetica,Arial,sans-serif" font-size="30"
        fill="#6b7899" text-anchor="middle">UWC Fleet — demo instance</text>
</svg>`,
    "utf-8"
  );
}

async function main() {
  assertNotProduction("seed-demo-pods");

  // Only stops the driver actually delivered. A POD on an undelivered stop
  // would be a lie about the data, not just about the photo.
  const stops = await prisma.tripStop.findMany({
    where: { status: "delivered", pod_photo: null },
    include: { trip: { select: { ticket_number: true } }, consignee: { select: { company_name: true } } },
    orderBy: [{ trip_id: "asc" }, { sequence: "asc" }],
  });

  if (stops.length === 0) {
    console.log("No delivered stops without a POD — nothing to do.");
    return;
  }
  console.log(`Found ${stops.length} delivered stop(s) with no POD.`);

  let done = 0;
  for (const stop of stops) {
    const ticket = stop.trip.ticket_number;
    const svg = placardSvg(ticket, stop.sequence, stop.consignee?.company_name ?? "Consignee");

    const { url, publicId } = await uploadBuffer(svg, "uwc/pod", {
      type: "authenticated",
      publicId: `${ticket}-stop-${stop.sequence}`,
    });

    // Same field set the real upload route writes, including the IM6 pair:
    // pod_uploaded_at is the server receipt, pod_captured_client_at is what the
    // device claimed. Backdated slightly so it reads as captured-then-uploaded.
    const receivedAt = stop.delivered_at ?? new Date();
    await prisma.tripStop.update({
      where: { id: stop.id },
      data: {
        pod_photo: url,
        pod_public_id: publicId,
        pod_uploaded_at: receivedAt,
        pod_captured_client_at: new Date(receivedAt.getTime() - 90_000),
      },
    });
    done += 1;
    console.log(`  ✓ ${ticket} stop ${stop.sequence} → ${publicId}`);
  }

  console.log(`\nAttached ${done} synthetic POD placard(s).`);
}

main()
  .catch((e) => {
    console.error("✖ seed-demo-pods:", e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
