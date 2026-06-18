import { test } from "node:test";
import assert from "node:assert/strict";

// Intentional failing test to trigger a CI build failure.
test("intentional build failure", () => {
    assert.equal(1, 2, "intentionally failing assertion");
});
