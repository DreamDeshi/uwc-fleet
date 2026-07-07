import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  TRIP_LIST_MAX_TAKE,
  TRIP_PAGE_SIZE_DEFAULT,
  TRIP_LIST_ORDER,
  buildTripPage,
  decodeTripCursor,
  encodeTripCursor,
  parseTripListQuery,
  tripKeysetWhere,
  type TripKeysetWhere,
} from "../src/lib/tripCursor";

/**
 * Keyset pagination for GET /trips (the cb6bd55 windowed-cap follow-up).
 *
 * The property the board depends on: pages must partition the list exactly —
 * no row served twice, no row skipped — even while new bookings are inserted
 * at the head between page fetches. Offset pagination breaks exactly there;
 * these tests pin that the keyset predicate doesn't.
 */

interface TripRow {
  id: string;
  created_at: Date;
  status: string;
}

// In-memory evaluator for exactly the where-shape tripKeysetWhere builds —
// the test-side stand-in for Postgres applying it to trips.
function matchesKeyset(row: TripRow, w: TripKeysetWhere): boolean {
  const [older, tie] = w.OR;
  return (
    row.created_at.getTime() < older.created_at.lt.getTime() ||
    (row.created_at.getTime() === tie.created_at.getTime() && row.id < tie.id.lt)
  );
}

// (created_at DESC, id DESC) — must agree with TRIP_LIST_ORDER.
function byListOrder(a: TripRow, b: TripRow): number {
  return (
    b.created_at.getTime() - a.created_at.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

// One paged request the way the route runs it: sort, optional row filter
// (role scope / admin filters), keyset predicate, take pageSize + 1.
function fetchPage(
  rows: TripRow[],
  pageSize: number,
  cursor: string | null,
  rowFilter?: (r: TripRow) => boolean
) {
  let candidates = [...rows].sort(byListOrder);
  if (rowFilter) candidates = candidates.filter(rowFilter);
  if (cursor !== null) {
    const decoded = decodeTripCursor(cursor);
    expect(decoded).not.toBeNull();
    const where = tripKeysetWhere(decoded!);
    candidates = candidates.filter((r) => matchesKeyset(r, where));
  }
  return buildTripPage(candidates.slice(0, pageSize + 1), pageSize);
}

// Walk every page to exhaustion, returning the concatenated items.
function walkAll(
  rows: TripRow[],
  pageSize: number,
  rowFilter?: (r: TripRow) => boolean
): TripRow[] {
  const out: TripRow[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = fetchPage(rows, pageSize, cursor, rowFilter);
    out.push(...page.items);
    if (page.next_cursor === null) return out;
    cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
}

let seq = 0;
function row(atMs: number, status = "completed"): TripRow {
  seq += 1;
  return {
    id: `c${String(seq).padStart(6, "0")}`,
    created_at: new Date(atMs),
    status,
  };
}

const T0 = new Date("2026-07-01T00:00:00Z").getTime();

describe("cursor encoding", () => {
  it("round-trips millisecond timestamps and ids exactly", () => {
    const r = { created_at: new Date("2026-07-06T15:04:05.123Z"), id: "cmc123abc" };
    const decoded = decodeTripCursor(encodeTripCursor(r));
    expect(decoded).not.toBeNull();
    expect(decoded!.created_at.getTime()).toBe(r.created_at.getTime());
    expect(decoded!.id).toBe(r.id);
  });

  it("rejects tampered or garbage cursors instead of restarting at page 1", () => {
    const garbage = [
      "",
      "not-base64!!",
      Buffer.from("[]").toString("base64url"),
      Buffer.from("null").toString("base64url"),
      Buffer.from(JSON.stringify({ t: "x", i: "y" })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: 1, i: "" })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: Infinity, i: "a" })).toString("base64url"),
    ];
    for (const g of garbage) expect(decodeTripCursor(g)).toBeNull();
  });
});

describe("parseTripListQuery", () => {
  it("no paging params = legacy mode with the cb6bd55 limit semantics", () => {
    expect(parseTripListQuery({})).toEqual({ mode: "legacy", limit: undefined });
    expect(parseTripListQuery({ limit: "300" })).toEqual({ mode: "legacy", limit: 300 });
    expect(parseTripListQuery({ limit: "9999" })).toEqual({
      mode: "legacy",
      limit: TRIP_LIST_MAX_TAKE,
    });
    // absent/invalid = legacy unlimited — pinned so mobile stays untouched
    for (const bad of ["0", "-5", "abc", "2.5"]) {
      expect(parseTripListQuery({ limit: bad })).toEqual({ mode: "legacy", limit: undefined });
    }
    // empty-string params read as absent, like the admin filter params
    expect(parseTripListQuery({ cursor: "" })).toEqual({ mode: "legacy", limit: undefined });
  });

  it("page_size and/or cursor switch to paged mode", () => {
    expect(parseTripListQuery({ page_size: "150" })).toEqual({
      mode: "paged",
      pageSize: 150,
      cursor: null,
    });
    expect(parseTripListQuery({ page_size: "9999" })).toEqual({
      mode: "paged",
      pageSize: TRIP_LIST_MAX_TAKE,
      cursor: null,
    });
    // malformed size still means "the client wants pages" — default, not legacy
    expect(parseTripListQuery({ page_size: "abc" })).toEqual({
      mode: "paged",
      pageSize: TRIP_PAGE_SIZE_DEFAULT,
      cursor: null,
    });
    // empty cursor + page_size = explicit first page
    expect(parseTripListQuery({ page_size: "50", cursor: "" })).toEqual({
      mode: "paged",
      pageSize: 50,
      cursor: null,
    });
    const cur = encodeTripCursor({ created_at: new Date(T0), id: "cabc" });
    const parsed = parseTripListQuery({ cursor: cur });
    expect(parsed.mode).toBe("paged");
    if (parsed.mode === "paged") {
      expect(parsed.pageSize).toBe(TRIP_PAGE_SIZE_DEFAULT);
      expect(parsed.cursor).toEqual({ created_at: new Date(T0), id: "cabc" });
    }
  });

  it("paged mode ignores the legacy limit param", () => {
    expect(parseTripListQuery({ limit: "25", page_size: "50" })).toEqual({
      mode: "paged",
      pageSize: 50,
      cursor: null,
    });
  });

  it("a corrupt non-empty cursor is a hard error, never page 1", () => {
    expect(parseTripListQuery({ cursor: "garbage" })).toEqual({ mode: "invalid_cursor" });
    expect(parseTripListQuery({ cursor: "garbage", page_size: "50" })).toEqual({
      mode: "invalid_cursor",
    });
  });
});

describe("buildTripPage", () => {
  it("a short fetch is the last page (null cursor)", () => {
    const rows = [row(T0 + 2000), row(T0 + 1000)];
    expect(buildTripPage(rows, 5)).toEqual({ items: rows, next_cursor: null });
    expect(buildTripPage([], 5)).toEqual({ items: [], next_cursor: null });
  });

  it("exactly pageSize rows back from a pageSize+1 fetch = no next page", () => {
    const rows = [row(T0 + 2000), row(T0 + 1000)];
    expect(buildTripPage(rows, 2).next_cursor).toBeNull();
  });

  it("the +1 row is dropped and the cursor points at the last SERVED row", () => {
    const rows = [row(T0 + 3000), row(T0 + 2000), row(T0 + 1000)];
    const page = buildTripPage(rows, 2);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeTripCursor(page.next_cursor!)).toEqual({
      created_at: rows[1].created_at,
      id: rows[1].id,
    });
  });
});

describe("keyset walk — no overlap, no gaps", () => {
  it("pages partition the whole list exactly, in order", () => {
    // 25 rows including same-millisecond clusters (bulk-created bookings) so
    // the id tiebreak is actually exercised on page boundaries.
    const rows: TripRow[] = [];
    for (let i = 0; i < 25; i++) rows.push(row(T0 + Math.floor(i / 3) * 1000));
    const walked = walkAll(rows, 10);
    expect(walked).toEqual([...rows].sort(byListOrder));
    expect(new Set(walked.map((r) => r.id)).size).toBe(25);
  });

  it("inserts at the head never shift, duplicate, or hide later pages", () => {
    const snapshot: TripRow[] = [];
    for (let i = 0; i < 20; i++) snapshot.push(row(T0 + i * 1000));
    const live = [...snapshot];

    const page1 = fetchPage(live, 8, null);
    const cursorRow = page1.items[page1.items.length - 1];

    // New bookings land between page fetches — strictly newer rows at the
    // head, plus a same-millisecond sibling of the cursor row on EACH side
    // of the id tiebreak (worst case for a boundary).
    live.push(row(T0 + 100_000), row(T0 + 101_000));
    seq += 1;
    live.push({ id: "a000000", created_at: cursorRow.created_at, status: "completed" }); // id < cursor → older side
    seq += 1;
    live.push({ id: "z999999", created_at: cursorRow.created_at, status: "completed" }); // id > cursor → newer side

    const page2 = fetchPage(live, 8, page1.next_cursor!);
    const page3 = fetchPage(live, 8, page2.next_cursor!);
    const served = [...page1.items, ...page2.items, ...page3.items];

    // No snapshot row lost or served twice despite the mid-walk inserts.
    const servedIds = served.map((r) => r.id);
    expect(new Set(servedIds).size).toBe(servedIds.length);
    for (const r of snapshot) expect(servedIds).toContain(r.id);
    // The head inserts stay off the already-cursored pages…
    expect(servedIds).not.toContain(live[20].id);
    expect(servedIds).not.toContain(live[21].id);
    expect(servedIds).not.toContain("z999999");
    // …while the tiebreak sibling on the OLDER side is picked up, not skipped.
    expect([...page2.items, ...page3.items].map((r) => r.id)).toContain("a000000");
    // A fresh page-1 fetch (the 20s poll) sees the new head rows immediately.
    const freshHead = fetchPage(live, 8, null);
    expect(freshHead.items.map((r) => r.id)).toContain(live[21].id);
  });

  it("composes with filters: a cursor from a filtered page continues the filtered sequence", () => {
    const rows: TripRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(row(T0 + i * 1000, i % 3 === 0 ? "pending" : "completed"));
    }
    const completedOnly = (r: TripRow) => r.status === "completed";
    const walked = walkAll(rows, 7, completedOnly);
    expect(walked).toEqual([...rows].sort(byListOrder).filter(completedOnly));
    // And inserts of non-matching rows can't disturb the filtered walk either.
    const page1 = fetchPage(rows, 7, null, completedOnly);
    rows.push(row(T0 + 200_000, "pending"));
    const page2 = fetchPage(rows, 7, page1.next_cursor!, completedOnly);
    const overlap = page2.items.filter((r) => page1.items.some((p) => p.id === r.id));
    expect(overlap).toEqual([]);
  });
});

describe("list order", () => {
  it("TRIP_LIST_ORDER is (created_at desc, id desc) — the cursor's exact order", () => {
    expect(TRIP_LIST_ORDER).toEqual([{ created_at: "desc" }, { id: "desc" }]);
  });
});

describe("keyset index migration", () => {
  it("is purely additive — CREATE INDEX only, no table/column/data change", () => {
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        "../prisma/migrations/20260707100000_trip_list_keyset_index/migration.sql"
      ),
      "utf-8"
    );
    const statements = sql
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("--"));
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).toMatch(/^CREATE INDEX /);
    }
    // And it creates exactly the index the keyset order needs.
    expect(sql).toContain(
      'CREATE INDEX "Trip_created_at_id_idx" ON "Trip"("created_at", "id");'
    );
  });
});
