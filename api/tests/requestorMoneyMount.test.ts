import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { redactRequestorMoneyLayer, redactRequestorMoney } from "../src/lib/requestorMoney";

/**
 * THE REDACTION ONLY COVERS WHAT IS MOUNTED AFTER IT.
 *
 * That is the entire guarantee, and until this file existed it was protected by
 * a comment. The history is the argument: `exceptionsRoutes` shares the
 * /api/v1/trips prefix with `tripsRoutes`, and while the wrapper lived inside
 * tripsRoutes it covered the exceptions router ONLY because tripsRoutes happened
 * to be mounted on the line above. Swapping two `app.use` lines would have
 * silently removed redaction from every exceptions-router response, and nothing
 * in the suite would have gone red.
 *
 * Moving the layer to app.ts ahead of both routers fixed that — but it replaced
 * one ordering dependency with another: the layer must stay ahead of everything
 * on the prefix. A future router mounted one line too early is the same bug
 * wearing a different hat.
 *
 * Two tests, because either alone is weak:
 *
 *   1. MECHANISM — a synthetic app proves order actually decides the outcome, so
 *      test 2 is asserting something that matters rather than a coding style.
 *   2. WIRING — the REAL app's stack is inspected, so the mechanism is verified
 *      where it ships. A synthetic-only test passes forever while production
 *      wiring rots.
 */

const MONEY_BODY = { id: "t1", incentive_earned: "44", truck: { entitled_claim_weekday: "11" } };

/** Minimal stand-in for a router mounted on the shared prefix. */
const moneyRouter = express.Router();
moneyRouter.get("/leaky", (_req, res) => {
  res.json(MONEY_BODY);
});

/** Stand-in for requireAuth: routers authenticate internally, as the real ones do. */
const asRequestor = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as unknown as { user: { role: string } }).user = { role: "requestor" };
  next();
};

describe("redaction layer position", () => {
  it("MECHANISM: a router mounted BEFORE the layer is not covered", async () => {
    const wrong = express();
    wrong.use("/trips", asRequestor);
    wrong.use("/trips", moneyRouter); // mounted too early
    wrong.use("/trips", redactRequestorMoneyLayer);

    const res = await request(wrong).get("/trips/leaky");
    expect(res.status).toBe(200);
    // Proof that ordering is load-bearing, not stylistic: the money is still here.
    expect(res.body.incentive_earned).toBe("44");
    expect(res.body.truck.entitled_claim_weekday).toBe("11");
  });

  it("MECHANISM: the same router mounted AFTER the layer is covered", async () => {
    const right = express();
    right.use("/trips", asRequestor);
    right.use("/trips", redactRequestorMoneyLayer);
    right.use("/trips", moneyRouter);

    const res = await request(right).get("/trips/leaky");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "t1", truck: {} });
  });

  it("WIRING: in the real app the layer precedes every router on /api/v1/trips", async () => {
    // Imported lazily so a failure here reads as a wiring problem rather than a
    // module-load error in the two tests above.
    const { app } = await import("../src/app");

    type Layer = { name?: string; handle?: unknown; regexp?: RegExp };
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;

    // Express compiles `app.use("/api/v1/trips", …)` into a layer whose regexp
    // matches that path; match by testing the path rather than parsing internals.
    //
    // The second test excludes GLOBAL middleware. `app.use(cors())` and friends
    // compile to a regexp matching everything, so they match /api/v1/trips too —
    // filtering on that alone put the redaction layer at index 6 behind cors,
    // the rate limiter and express.json, none of which are on this prefix at all.
    // A prefix-mounted layer matches /api/v1/trips and NOT a sibling prefix.
    const onTripsPrefix = stack
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.regexp?.test("/api/v1/trips") && !layer.regexp?.test("/api/v1/users"));

    expect(
      onTripsPrefix.length,
      "no layers found on /api/v1/trips — Express internals may have changed shape"
    ).toBeGreaterThan(1);

    const layerIndex = onTripsPrefix.findIndex(({ layer }) => layer.handle === redactRequestorMoneyLayer);
    expect(layerIndex, "redactRequestorMoneyLayer is not mounted on /api/v1/trips at all").toBeGreaterThanOrEqual(0);

    // It must be the FIRST thing on this prefix. Anything ahead of it — a router
    // added later, or these two lines reordered — is unredacted for requestors.
    expect(
      layerIndex,
      [
        "",
        "A handler is mounted on /api/v1/trips BEFORE the redaction layer.",
        "Everything ahead of it returns driver pay to requestors, silently.",
        "Move redactRequestorMoneyLayer back to the first app.use on this prefix.",
        "",
      ].join("\n")
    ).toBe(0);
  });

  it("the layer leaves non-requestor roles alone", async () => {
    const app = express();
    app.use("/trips", (req, _res, next) => {
      (req as unknown as { user: { role: string } }).user = { role: "driver" };
      next();
    });
    app.use("/trips", redactRequestorMoneyLayer);
    app.use("/trips", moneyRouter);

    const res = await request(app).get("/trips/leaky");
    expect(res.body).toEqual(MONEY_BODY);
    // and the pure function is unchanged by any of this
    expect(redactRequestorMoney(MONEY_BODY)).toEqual({ id: "t1", truck: {} });
  });
});
