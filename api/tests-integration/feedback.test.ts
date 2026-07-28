import { describe, it, expect, afterAll } from "vitest";
import { api, auth, prisma, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";

/**
 * In-app feedback (28 Jul 2026): any signed-in role can file a bug / idea /
 * gripe; the admin reads the inbox. AuditLog-backed (table_name "Feedback"),
 * so no resetDb needed — rows accumulate; assertions use a unique marker.
 */
describe("Feedback — submit (any role) + admin inbox", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("driver submits, admin reads it back with category + submitter", async () => {
    const [driver, admin] = await Promise.all([loginAs(DRIVER), loginAs(ADMIN)]);
    const marker = `integration-feedback-${Date.now()}`;

    const post = await api()
      .post("/api/v1/feedback")
      .set(auth(driver))
      .send({ category: "bug", message: `${marker} — map pin lands on the wrong building`, screen: "driver-profile" });
    expect(post.status).toBe(201);

    const inbox = await api().get("/api/v1/feedback").set(auth(admin));
    expect(inbox.status).toBe(200);
    const row = inbox.body.feedback.find((f: { message: string }) => f.message.includes(marker));
    expect(row).toBeTruthy();
    expect(row.category).toBe("bug");
    expect(row.role).toBe("driver");
    expect(row.user_name).toBeTruthy();
    expect(row.message).toContain("[screen: driver-profile]");
  });

  it("requestor and admin can submit too (all three roles covered)", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const marker = `integration-feedback-${Date.now()}`;

    expect(
      (
        await api()
          .post("/api/v1/feedback")
          .set(auth(requestor))
          .send({ category: "idea", message: `${marker} requestor idea` })
      ).status
    ).toBe(201);
    expect(
      (
        await api()
          .post("/api/v1/feedback")
          .set(auth(admin))
          .send({ category: "other", message: `${marker} admin note` })
      ).status
    ).toBe(201);

    const inbox = await api().get("/api/v1/feedback").set(auth(admin));
    const mine = inbox.body.feedback.filter((f: { message: string }) => f.message.includes(marker));
    expect(mine).toHaveLength(2);
  });

  it("the inbox is admin-only; submitting requires auth; bad payloads are rejected", async () => {
    const driver = await loginAs(DRIVER);

    expect((await api().get("/api/v1/feedback").set(auth(driver))).status).toBe(403);
    expect((await api().post("/api/v1/feedback").send({ category: "bug", message: "no auth here" })).status).toBe(401);

    const badCategory = await api()
      .post("/api/v1/feedback")
      .set(auth(driver))
      .send({ category: "rant", message: "category not in the enum" });
    expect(badCategory.status).toBe(400);

    const tooShort = await api().post("/api/v1/feedback").set(auth(driver)).send({ category: "bug", message: "hi" });
    expect(tooShort.status).toBe(400);
  });
});
