import assert from "node:assert/strict";
import test from "node:test";
import { parseModelPriceUpdate } from "../src/dashboard/routes/settings-routes.js";

test("parseModelPriceUpdate rejects blank form fields", () => {
  assert.equal(parseModelPriceUpdate({ inputPerM: "", outputPerM: "" }), null);
  assert.equal(parseModelPriceUpdate({ inputPerM: "1.25", outputPerM: "" }), null);
});

test("parseModelPriceUpdate accepts numeric strings", () => {
  assert.deepEqual(parseModelPriceUpdate({ inputPerM: "1.25", outputPerM: "2.5" }), {
    inputPerM: 1.25,
    outputPerM: 2.5,
  });
});
