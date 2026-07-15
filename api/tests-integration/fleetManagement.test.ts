import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, bookTrip, approveTrip, startTrip, userIdByPhone, DRIVERS } from "./helpers/flow";

/**
 * Fleet management (admin CRUD): add/retire drivers & trucks, and the 1:1
 * driver↔truck binding. Every mutation is admin-guarded and audit-logged; the
 * guards protect the binding (unique / not-retired) and live trips.
 *
 * Isolation: users and trucks are MASTER data (not truncated by resetDb), so
 * this suite cleans up its own test rows (phone/plate prefixes) each run.
 */

const TEST_PHONE = "+60177000001"; // a created test driver
const TEST_PHONE_2 = "+60177000002";
const TEST_PLATE = "TST 0001";
const TEST_PLATE_2 = "TST 0002";

async function cleanupFleetTestRows() {
  await prisma.user.deleteMany({ where: { phone: { in: [TEST_PHONE, TEST_PHONE_2] } } });
  await prisma.truck.deleteMany({ where: { plate: { in: [TEST_PLATE, TEST_PLATE_2] } } });
}

async function deptId(): Promise<string> {
  const d = await prisma.department.findFirst();
  if (!d) throw new Error("no department seeded");
  return d.id;
}

const truckBody = (plate: string) => ({
  plate,
  type: "10t-30ft",
  max_pallets: 16,
  entitled_claim_weekday: 55,
  entitled_claim_offpeak: 66,
  daily_deduction_points: 2,
  priority_zones: ["P1", "P2"],
});

describe("Fleet management — driver + truck CRUD", () => {
  beforeEach(async () => {
    await resetDb();
    await cleanupFleetTestRows();
  });
  afterAll(async () => {
    await cleanupFleetTestRows();
    await prisma.$disconnect();
  });

  it("adds a truck, then adds a driver and binds the truck — driver becomes dispatchable", async () => {
    const admin = await loginAs(ADMIN);

    // Add a truck.
    const truck = await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));
    expect(truck.status).toBe(201);
    expect(truck.body.plate).toBe(TEST_PLATE);

    // It shows in the fleet as an idle, non-retired truck with no driver.
    const trucks = await api().get("/api/v1/trucks").set(auth(admin));
    const listed = (trucks.body as any[]).find((t) => t.plate === TEST_PLATE);
    expect(listed).toBeTruthy();
    expect(listed.status).toBe("idle");
    expect(listed.retired_at).toBeNull();
    expect(listed.driver).toBeNull();

    // Add a driver with no truck yet.
    const created = await api()
      .post("/api/v1/users")
      .set(auth(admin))
      .send({
        phone: TEST_PHONE,
        password: "Password123",
        name: "Test New Driver",
        employee_number: "T-001",
        department_id: await deptId(),
      });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("driver");
    expect(created.body.status).toBe("active");
    expect(created.body.assigned_truck_plate).toBeNull();
    const driverId = created.body.id as string;

    // Bind the truck to the new driver.
    const bind = await api()
      .patch(`/api/v1/users/${driverId}/truck`)
      .set(auth(admin))
      .send({ plate: TEST_PLATE });
    expect(bind.status).toBe(200);
    expect(bind.body.assigned_truck_plate).toBe(TEST_PLATE);

    // The driver board now shows them active with their truck.
    const board = await api().get("/api/v1/reports/drivers").set(auth(admin));
    const onBoard = (board.body as any[]).find((d) => d.id === driverId);
    expect(onBoard).toBeTruthy();
    expect(onBoard.account_status).toBe("active");
    expect(onBoard.assigned_truck?.plate).toBe(TEST_PLATE);

    // The new driver can actually log in.
    const token = await loginAs({ phone: TEST_PHONE, password: "Password123" });
    expect(token).toBeTruthy();
  });

  it("the login ID is created — a new driver can authenticate immediately", async () => {
    const admin = await loginAs(ADMIN);
    await api()
      .post("/api/v1/users")
      .set(auth(admin))
      .send({
        phone: TEST_PHONE,
        password: "Password123",
        name: "Loginable",
        employee_number: "T-009",
        department_id: await deptId(),
      });
    const res = await api().post("/api/v1/auth/login").send({ phone: TEST_PHONE, password: "Password123" });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("retires a truck: frees its driver, excludes it from dispatch alerts, un-retires cleanly", async () => {
    const admin = await loginAs(ADMIN);
    // Truck + driver bound to it.
    await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));
    const created = await api()
      .post("/api/v1/users")
      .set(auth(admin))
      .send({
        phone: TEST_PHONE,
        password: "Password123",
        name: "Departing Driver",
        employee_number: "T-002",
        department_id: await deptId(),
        assigned_truck_plate: TEST_PLATE,
      });
    const driverId = created.body.id as string;
    expect(created.body.assigned_truck_plate).toBe(TEST_PLATE);

    // Retire the truck.
    const retire = await api().patch(`/api/v1/trucks/${encodeURIComponent(TEST_PLATE)}/retire`).set(auth(admin)).send({ retired: true });
    expect(retire.status).toBe(200);
    expect(retire.body.retired_at).toBeTruthy();
    expect(retire.body.is_available).toBe(false);

    // The driver is freed (truck can be reassigned).
    const freed = await prisma.user.findUnique({ where: { id: driverId } });
    expect(freed!.assigned_truck_plate).toBeNull();

    // Fleet shows it retired; alerts exclude it.
    const trucks = await api().get("/api/v1/trucks").set(auth(admin));
    const listed = (trucks.body as any[]).find((t) => t.plate === TEST_PLATE);
    expect(listed.status).toBe("retired");
    const alerts = await api().get("/api/v1/trucks/alerts").set(auth(admin));
    expect((alerts.body as any[]).find((t) => t.plate === TEST_PLATE)).toBeUndefined();

    // Un-retire → active again.
    const un = await api().patch(`/api/v1/trucks/${encodeURIComponent(TEST_PLATE)}/retire`).set(auth(admin)).send({ retired: false });
    expect(un.status).toBe(200);
    expect(un.body.retired_at).toBeNull();
    expect(un.body.is_available).toBe(true);
  });

  it("guards the 1:1 binding: can't take a truck held by another driver, or a retired truck", async () => {
    const admin = await loginAs(ADMIN);
    await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));

    // Driver A takes the truck.
    const a = await api().post("/api/v1/users").set(auth(admin)).send({
      phone: TEST_PHONE, password: "Password123", name: "Driver A", employee_number: "T-003",
      department_id: await deptId(), assigned_truck_plate: TEST_PLATE,
    });
    // Driver B (no truck).
    const b = await api().post("/api/v1/users").set(auth(admin)).send({
      phone: TEST_PHONE_2, password: "Password123", name: "Driver B", employee_number: "T-004",
      department_id: await deptId(),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // B can't take A's truck.
    const clash = await api().patch(`/api/v1/users/${b.body.id}/truck`).set(auth(admin)).send({ plate: TEST_PLATE });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("TRUCK_ALREADY_ASSIGNED");

    // Retire the truck (frees A), then B still can't take a RETIRED truck.
    await api().patch(`/api/v1/trucks/${encodeURIComponent(TEST_PLATE)}/retire`).set(auth(admin)).send({ retired: true });
    const retiredClash = await api().patch(`/api/v1/users/${b.body.id}/truck`).set(auth(admin)).send({ plate: TEST_PLATE });
    expect(retiredClash.status).toBe(409);
    expect(retiredClash.body.error.code).toBe("TRUCK_RETIRED");
  });

  it("blocks a truck change / retire while a live trip is in flight", async () => {
    const [admin, requestor, driver] = await Promise.all([loginAs(ADMIN), loginAs(REQUESTOR), loginAs(DRIVER)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, DRIVERS.PLX.plate);
    await startTrip(driver, trip.id); // in_progress

    // Can't reassign the driver's truck mid-trip.
    const reassign = await api().patch(`/api/v1/users/${plx}/truck`).set(auth(admin)).send({ plate: TEST_PLATE });
    expect(reassign.status).toBe(409);
    expect(reassign.body.error.code).toBe("DRIVER_HAS_ACTIVE_TRIP");

    // Can't retire the truck mid-trip.
    const retire = await api().patch(`/api/v1/trucks/${encodeURIComponent(DRIVERS.PLX.plate)}/retire`).set(auth(admin)).send({ retired: true });
    expect(retire.status).toBe(409);
    expect(retire.body.error.code).toBe("TRUCK_HAS_ACTIVE_TRIP");
  });

  it("rejects duplicate plate / duplicate phone, and non-admins entirely", async () => {
    const admin = await loginAs(ADMIN);
    await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));
    const dupTruck = await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));
    expect(dupTruck.status).toBe(409);
    expect(dupTruck.body.error.code).toBe("TRUCK_EXISTS");

    await api().post("/api/v1/users").set(auth(admin)).send({
      phone: TEST_PHONE, password: "Password123", name: "Dup", employee_number: "T-005", department_id: await deptId(),
    });
    const dupPhone = await api().post("/api/v1/users").set(auth(admin)).send({
      phone: TEST_PHONE, password: "Password123", name: "Dup2", employee_number: "T-006", department_id: await deptId(),
    });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.error.code).toBe("PHONE_ALREADY_REGISTERED");

    // A requestor (non-admin) is refused every fleet mutation.
    const requestor = await loginAs(REQUESTOR);
    expect((await api().post("/api/v1/trucks").set(auth(requestor)).send(truckBody(TEST_PLATE_2))).status).toBe(403);
    expect((await api().post("/api/v1/users").set(auth(requestor)).send({
      phone: TEST_PHONE_2, password: "Password123", name: "X", employee_number: "T-007", department_id: await deptId(),
    })).status).toBe(403);
  });

  it("edits truck attributes without touching rates (money path untouched)", async () => {
    const admin = await loginAs(ADMIN);
    await api().post("/api/v1/trucks").set(auth(admin)).send(truckBody(TEST_PLATE));

    const edit = await api().patch(`/api/v1/trucks/${encodeURIComponent(TEST_PLATE)}`).set(auth(admin)).send({
      type: "3t-17ft",
      max_pallets: 8,
      priority_zones: ["K1"],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.type).toBe("3t-17ft");
    expect(edit.body.max_pallets).toBe(8);
    // Rates are unchanged by the attribute edit.
    expect(Number(edit.body.entitled_claim_weekday)).toBe(55);
    expect(Number(edit.body.entitled_claim_offpeak)).toBe(66);
  });
});
