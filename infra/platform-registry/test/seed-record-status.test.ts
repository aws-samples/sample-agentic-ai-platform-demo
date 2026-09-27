import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSeedRecordStatus } from "../lib/seed-record-status";

test("normalizes console review status to the AWS approval status", () => {
  assert.equal(
    normalizeSeedRecordStatus("IN_REVIEW"),
    "PENDING_APPROVAL",
  );
});

test("preserves supported AWS seed statuses and rejects unknown values", () => {
  assert.equal(normalizeSeedRecordStatus("DRAFT"), "DRAFT");
  assert.equal(normalizeSeedRecordStatus("PENDING_APPROVAL"), "PENDING_APPROVAL");
  assert.equal(normalizeSeedRecordStatus("APPROVED"), "APPROVED");
  assert.equal(normalizeSeedRecordStatus(undefined), "APPROVED");
  assert.throws(
    () => normalizeSeedRecordStatus("REJECTED"),
    /Unsupported seed record status: REJECTED/,
  );
});
