import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ExposureInputSource } from "../../src/execution/index.js";
import { buildIntent, createHarness, grant } from "./helpers.js";

function exposureOf(signedPosition: string, markOrMidPrice: string): ExposureInputSource {
  return { read: async () => ({ signedPosition, markOrMidPrice }) };
}

describe("P3 exposure gate exact arithmetic", () => {
  test("P3-X01 a single intent just above the cap sends nothing", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch([
      buildIntent({ quantity: "1", price: `150.${"0".repeat(38)}1` }),
    ]);
    assert.deepEqual(result, {
      disposition: "REFUSED",
      reasonCodes: ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"],
      items: [],
    });
    assert.equal(h.venue.calls.place, 0);
  });

  test("P3-X02 a full batch whose exact sum is just above the cap sends nothing", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch([
      buildIntent({ quantity: "1.49" }),
      buildIntent({ logicalLevelId: "B2", quantity: "0.01", price: `100.${"0".repeat(39)}1` }),
    ]);
    assert.deepEqual(result, {
      disposition: "REFUSED",
      reasonCodes: ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"],
      items: [],
    });
    assert.equal(h.venue.calls.place, 0);
    assert.equal(h.registry.list().length, 0);
  });

  test("P3-X03 exposure inputs beyond the exact digit bound fail closed without sending", async () => {
    const h = await createHarness({ exposure: exposureOf(`1.49${"0".repeat(1100)}1`, "100") });
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch([buildIntent()]);
    assert.deepEqual(result, {
      disposition: "REFUSED",
      reasonCodes: [
        "PLANNED_EXPOSURE_DENIED",
        "UNBOUNDED_EXPOSURE",
        "INVALID_DECIMAL",
        "PLANNED_NOTIONAL",
      ],
      items: [],
    });
    assert.equal(h.venue.calls.place, 0);
  });

  test("P3-X04 control: a full batch exactly at the cap still sends", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch([
      buildIntent({ quantity: "1.49" }),
      buildIntent({ logicalLevelId: "B2", quantity: "0.01" }),
    ]);
    assert.equal(result.disposition, "SUBMITTED");
    assert.equal(h.venue.calls.place, 2);
  });
});
