import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";

/**
 * /health answers TWO questions, and the second one is new.
 *
 * "Is it up" was always answerable. "Is the code I just merged the code that is
 * answering" was not — after a merge, `deployed` was an inference from the merge
 * having happened, never an observation. On 1 Aug the only thing that could
 * settle it was a temporary debug route that then had to be removed again, which
 * is a silly amount of ceremony for one string.
 *
 * The SHA is safe to serve: it names a commit in a PUBLIC repository, so it
 * discloses nothing `git log` does not.
 */
const ORIGINAL = process.env.RAILWAY_GIT_COMMIT_SHA;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = ORIGINAL;
});

describe("GET /api/v1/health", () => {
  it("reports the running build, so a deploy can be confirmed from outside", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "d950ba9565661e9025888a45b71c02655bcf17f0";
    const { app } = await import("../src/app");

    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.release).toBe("d950ba9565661e9025888a45b71c02655bcf17f0");
  });

  it("is null off Railway rather than absent, so the field is always present", async () => {
    // A missing key and a null read the same to a human and differently to a
    // script. Local and CI runs have no SHA; the shape should not change.
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    const { app } = await import("../src/app");

    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("release");
    expect(res.body.release).toBeNull();
  });

  it("stays unauthenticated and says nothing else", async () => {
    // It is a public endpoint. Anything added here is publicly readable, so the
    // shape is pinned: a future field goes through this test first.
    const { app } = await import("../src/app");
    const res = await request(app).get("/api/v1/health");
    expect(Object.keys(res.body).sort()).toEqual(["release", "status"]);
  });
});
