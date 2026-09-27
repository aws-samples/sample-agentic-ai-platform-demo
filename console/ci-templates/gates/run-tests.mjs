// platform-gate: v1 — test gate runner. Auto-detects the repo's test suite:
//   1. package.json with a "test" script  -> npm test
//   2. *.test.mjs / *.test.js files       -> node --test
//   3. pytest config or test_*.py files   -> pip install -e app dirs, pytest
// Fail-closed (aligned with the eval gate's "never passes vacuously"
// philosophy, R-015): a repo with no detectable tests FAILS unless
// gates/platform-gates.json explicitly declares "allowNoTests": true.
import { existsSync, readFileSync, globSync } from "node:fs"
import { execFileSync, execSync } from "node:child_process"

function sh(cmd) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit" })
}

function allowNoTests() {
  try {
    const cfg = JSON.parse(readFileSync("gates/platform-gates.json", "utf8"))
    return cfg.preset === "MINIMAL" && cfg.allowNoTests === true
  }
  catch { return false }
}

if (existsSync("gates/check-resource-bindings.mjs")) {
  sh("node gates/check-resource-bindings.mjs")
}

if (existsSync("package.json") && JSON.parse(readFileSync("package.json", "utf8")).scripts?.test) {
  sh("npm ci --no-audit --no-fund || npm install --no-audit --no-fund")
  sh("npm test")
  process.exit(0)
}

// CLI packaging and CDK compilation leave generated copies beside the source.
// Those copies may contain a different test framework or third-party tests.
const generated = new Set(["node_modules", ".venv", ".git", "dist", "build", "cdk.out", ".cache", "__pycache__"])
let packagedRuntimeDirectories = []
if (existsSync("agentcore/agentcore.json")) {
  const spec = JSON.parse(readFileSync("agentcore/agentcore.json", "utf8"))
  packagedRuntimeDirectories = (spec.runtimes || []).map(runtime => `agentcore/${runtime.name}`)
}
const excludeGenerated = p => p.split(/[\\/]/).some(part => generated.has(part))
  || packagedRuntimeDirectories.some(directory => p === directory || p.startsWith(directory + "/"))
// Early Node 22 glob callbacks receive basenames during traversal; filter the
// final relative paths too so a packaged runtime never shadows app source.
const nodeTests = globSync("**/*.test.{mjs,js}", { exclude: excludeGenerated }).filter(p => !excludeGenerated(p))
if (nodeTests.length) {
  sh(`node --test ${nodeTests.map(t => `"${t}"`).join(" ")}`)
  process.exit(0)
}

const pyTests = globSync("**/{test_*,*_test}.py", { exclude: excludeGenerated }).filter(p => !excludeGenerated(p))
if (pyTests.length || existsSync("pytest.ini") || existsSync("tests")) {
  // A developer machine may have pip and pytest from different Python installs.
  // Install and execute through one interpreter, preferring this repo's venv.
  const python = [".venv/bin/python", ".venv/Scripts/python.exe"].find(existsSync) || "python3"
  const runPython = args => {
    console.log(`$ ${python} ${args.join(" ")}`)
    execFileSync(python, args, { stdio: "inherit" })
  }
  runPython(["-m", "pip", "install", "--quiet", "pytest"])
  for (const py of globSync("app/*/pyproject.toml")) runPython(["-m", "pip", "install", "--quiet", "-e", py.replace(/\/pyproject\.toml$/, "")])
  runPython(["-m", "pytest", "-q", ...pyTests])
  process.exit(0)
}

console.log("WARNING: no test suite detected (no package.json test script, *.test.js/mjs, or pytest tests).")
if (allowNoTests()) {
  console.log("gates/platform-gates.json declares \"allowNoTests\": true \u2014 passing vacuously as explicitly exempted.")
  process.exit(0)
}
console.error("\nTEST GATE FAILED\nNo tests detected, and no explicit exemption.")
console.error("Fix one of the following:")
console.error("  1. Add tests: a package.json \"test\" script, *.test.mjs/*.test.js files, or pytest test_*.py files.")
console.error("  2. If this repo genuinely ships no testable code yet, add \"allowNoTests\": true to gates/platform-gates.json")
console.error("     to explicitly exempt it (a deliberate, visible choice \u2014 not a silent default).")
process.exit(1)
