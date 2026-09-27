// platform-gate: v1 — block tests and deployment until governed resources
// selected for this repository have deployable bindings.
import { readFileSync } from "node:fs"

function fail(message) {
  console.error(`\nRESOURCE BINDING CHECK FAILED\n${message}`)
  process.exit(1)
}

let harness
try {
  harness = JSON.parse(readFileSync("domain-harness.json", "utf8"))
} catch {
  fail("domain-harness.json is missing or invalid.")
}

if (!Array.isArray(harness.resources)) {
  fail("domain-harness.json resources must be an array.")
}

const unresolved = []
for (const [index, resource] of harness.resources.entries()) {
  const valid = resource
    && typeof resource === "object"
    && !Array.isArray(resource)
    && typeof resource.type === "string"
    && typeof resource.id === "string"
    && typeof resource.version === "string"
    && resource.binding
    && typeof resource.binding === "object"
    && !Array.isArray(resource.binding)
    && typeof resource.binding.adapter === "string"
    && ["MATERIALIZED", "DEPLOYMENT_REQUIRED"].includes(resource.binding.status)
  if (!valid) fail(`Governed resource ${index + 1} has an invalid portable binding.`)
  if (resource.binding.status === "DEPLOYMENT_REQUIRED") {
    unresolved.push(`${resource.type}:${resource.id}@${resource.version}`)
  }
}

if (unresolved.length) {
  fail(
    `DEPLOYMENT_REQUIRED: materialize these governed resources before testing or deployment:\n${unresolved.map((resource) => ` - ${resource}`).join("\n")}`,
  )
}

console.log(`Resource bindings: PASS (${harness.resources.length} materialized resource(s))`)
