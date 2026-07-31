import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  redactRequestorMoneyLayer,
  redactRequestorMoney,
  REQUESTOR_REDACTED_PREFIXES,
} from "../src/lib/requestorMoney";

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

  it("WIRING: in the real app the layer leads EVERY prefix it claims to protect", async () => {
    // Imported lazily so a failure here reads as a wiring problem rather than a
    // module-load error in the two tests above.
    const { app } = await import("../src/app");

    type Layer = { name?: string; handle?: unknown; regexp?: RegExp };
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;

    // Express compiles `app.use("/api/v1/x", …)` into a layer whose regexp
    // matches that path; match by testing the path rather than parsing internals.
    //
    // GLOBAL middleware must be excluded. `app.use(cors())` and friends compile
    // to a regexp matching everything, so they match every prefix too —
    // filtering on that alone put the redaction layer at index 6 behind cors,
    // the rate limiter and express.json, none of which are on the prefix at all.
    // A prefix-mounted layer matches its own path and NOT an unrelated one.
    const CONTROL = "/api/v1/__not_a_real_prefix__";
    const failures: string[] = [];

    for (const prefix of REQUESTOR_REDACTED_PREFIXES) {
      const onPrefix = stack
        .map((layer, index) => ({ layer, index }))
        .filter(({ layer }) => layer.regexp?.test(prefix) && !layer.regexp?.test(CONTROL));

      if (onPrefix.length <= 1) {
        failures.push(`${prefix}: no prefix-mounted layers found — Express internals may have changed shape`);
        continue;
      }
      const layerIndex = onPrefix.findIndex(({ layer }) => layer.handle === redactRequestorMoneyLayer);
      if (layerIndex < 0) failures.push(`${prefix}: redactRequestorMoneyLayer is not mounted here at all`);
      else if (layerIndex !== 0) {
        failures.push(`${prefix}: ${layerIndex} handler(s) are mounted BEFORE the redaction layer`);
      }
    }

    expect(
      failures,
      [
        "",
        "The requestor field guard is not leading a prefix it is supposed to protect:",
        ...failures.map((f) => `  ${f}`),
        "",
        "Anything mounted ahead of it returns unredacted fields to requestors, silently.",
        "The mount loop lives in app.ts and is driven by REQUESTOR_REDACTED_PREFIXES.",
        "",
      ].join("\n")
    ).toEqual([]);
  });

  it("WIRING: the prefix list names only prefixes the app actually mounts", async () => {
    // No blank cheques, same rule as the fail-closed allow-list: a prefix in the
    // list that nothing is mounted on would make the test above vacuous for it,
    // and would read as coverage that does not exist.
    const { app } = await import("../src/app");
    type Layer = { handle?: unknown; regexp?: RegExp };
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
    const CONTROL = "/api/v1/__not_a_real_prefix__";

    const empty = REQUESTOR_REDACTED_PREFIXES.filter((prefix) => {
      const onPrefix = stack.filter(
        (l) => l.regexp?.test(prefix) && !l.regexp?.test(CONTROL) && l.handle !== redactRequestorMoneyLayer
      );
      return onPrefix.length === 0;
    });
    expect(empty, `REQUESTOR_REDACTED_PREFIXES names prefix(es) with no router: ${empty.join(", ")}`).toEqual([]);
  });

  it("the prefix list cannot be SHRUNK past the requestor-reachable routers", async () => {
    // The list is its own oracle: deleting a prefix removes the mount AND the
    // assertion above, so the previous test stays green while protection
    // disappears. Deleting "/api/v1/users" from REQUESTOR_REDACTED_PREFIXES was
    // measured to do exactly that.
    //
    // So the prefixes a requestor can actually reach are named HERE, in the
    // test, deliberately as a second statement of the requirement — app.ts says
    // what is mounted, this says what must be. Established by reading the role
    // guards, not assumed:
    //
    //   /trips        tripsRoutes + exceptionsRoutes, requestor owns trips
    //   /consignees   GET / has no role guard; POST / is requestor+admin
    //   /users        meRoutes (GET/PATCH /users/me) is any authenticated user
    //
    // /trucks and /incentives are absent on purpose: no requestor-reachable
    // route today, so their presence in the list is prophylactic and removing
    // them would be a judgement call, not a regression.
    const MUST_COVER = ["/api/v1/trips", "/api/v1/consignees", "/api/v1/users"];
    const missing = MUST_COVER.filter((p) => !REQUESTOR_REDACTED_PREFIXES.includes(p as never));
    expect(
      missing,
      [
        "",
        "Prefix(es) a REQUESTOR CAN REACH are no longer in REQUESTOR_REDACTED_PREFIXES:",
        ...missing.map((p) => `  ${p}`),
        "",
        "Removing one silently drops the field guard from that router.",
        "",
      ].join("\n")
    ).toEqual([]);
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
