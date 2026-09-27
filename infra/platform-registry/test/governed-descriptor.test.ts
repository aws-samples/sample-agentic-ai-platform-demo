import assert from "node:assert/strict";
import test from "node:test";
import {
  REGISTRY_RECORD_VERSION_PATTERN,
  governedRecordVersion,
  hasGovernedRecordVersion,
} from "../lib/governed-descriptor";

test("governed marker is carried in the prerelease segment", () => {
  assert.equal(
    governedRecordVersion("1.0.0"),
    "1.0.0-platform-descriptor.1",
  );
  assert.equal(
    governedRecordVersion("1.0.0-rc.platform-descriptor.1"),
    "1.0.0-rc.platform-descriptor.1",
  );
  assert.equal(
    governedRecordVersion("1.0.0+vendor"),
    "1.0.0-vendor.platform-descriptor.1",
  );
  assert.equal(
    governedRecordVersion("1.0.0+platform-descriptor.1"),
    "1.0.0-platform-descriptor.1",
  );
  assert.throws(
    () => governedRecordVersion("1.0.0-01"),
    /SemVer/,
  );
});

test("governed record versions satisfy the registry service constraint", () => {
  for (const input of ["1.0.0", "2.3.4-beta.7", "1.0.0+vendor"]) {
    const version = governedRecordVersion(input);
    assert.match(version, REGISTRY_RECORD_VERSION_PATTERN);
    assert.ok(!version.includes("+"));
    assert.ok(hasGovernedRecordVersion(version));
  }
});

test("versions carrying + build metadata are rejected by the validator", () => {
  assert.equal(
    hasGovernedRecordVersion("1.0.0+platform-descriptor.1"),
    false,
  );
  assert.doesNotMatch(
    "1.0.0+platform-descriptor.1",
    REGISTRY_RECORD_VERSION_PATTERN,
  );
  assert.equal(hasGovernedRecordVersion("1.0.0"), false);
  assert.equal(
    hasGovernedRecordVersion("1.0.0-platform-descriptor.1"),
    true,
  );
});
