import { describe, expect, it } from "vitest";
import { estimateTripCo2, EST_CO2E_KG_PER_LITRE, EST_L_PER_100KM } from "./tripCo2";
import { PLANT_ORIGIN, haversineKm, zoneCoord } from "./geo";

describe("estimateTripCo2", () => {
  it("uses the farthest stop, round trip, geocoded building preferred", () => {
    const near = { consignee: { latitude: 5.35, longitude: 100.4, zone_code: "P2" } };
    const far = { consignee: { latitude: 4.5975, longitude: 101.0901, zone_code: "A2" } }; // Ipoh
    const est = estimateTripCo2([near, far]);
    expect(est).not.toBeNull();
    const expectKm = Math.round(
      haversineKm(PLANT_ORIGIN, { latitude: 4.5975, longitude: 101.0901 }) * 2
    );
    expect(est!.km).toBe(expectKm);
    const litres = (expectKm * EST_L_PER_100KM) / 100;
    expect(est!.co2Kg).toBe(Math.round(litres * EST_CO2E_KG_PER_LITRE * 10) / 10);
  });

  it("falls back to the zone centroid when the consignee has no coords", () => {
    const est = estimateTripCo2([{ consignee: { zone_code: "A1" } }]);
    expect(est).not.toBeNull();
    expect(est!.km).toBe(Math.round(haversineKm(PLANT_ORIGIN, zoneCoord("A1")) * 2));
  });

  it("uses the fallback zone when there are no stops, and null with nothing at all", () => {
    const est = estimateTripCo2([], "KL");
    expect(est).not.toBeNull();
    expect(estimateTripCo2([])).toBeNull();
  });
});
