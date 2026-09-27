import { frontendSource, appSource } from "./test-support/frontend-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = frontendSource;
const serverSource = readFileSync(
  new URL("./server.mjs", import.meta.url),
  "utf8",
);
const demoAssistSource = readFileSync(
  new URL("./public/demo-assist.mjs", import.meta.url),
  "utf8",
);
const guardrailContractSource = readFileSync(
  new URL("./public/guardrail-chain.mjs", import.meta.url),
  "utf8",
);
const moduleSource = appSource;

function initializer(name, nextName) {
  const match = moduleSource.match(new RegExp(
    `const ${name}\\s*=\\s*([\\s\\S]*?)\\nconst ${nextName}\\s*=`,
  ));
  assert.ok(match, `expected ${name} before ${nextName}`);
  return match[1].trim();
}

function sourceBetween(startMarker, endMarker) {
  const start = moduleSource.indexOf(startMarker);
  const end = moduleSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `expected source marker: ${startMarker}`);
  assert.notEqual(end, -1, `expected source marker: ${endMarker}`);
  return moduleSource.slice(start, end);
}

test("runtime configuration loads immediately before the authentication-aware module", () => {
  assert.match(
    html,
    /<script src="\/runtime-config\.js"><\/script>\s*<script type="module" src="\/modules\/app\.mjs"><\/script>/,
  );
  assert.match(
    moduleSource,
    /^\s*import\s*{[\s\S]*\bauthMode\b[\s\S]*\bbeginSignIn\b[\s\S]*\bclearAuthentication\b[\s\S]*\bcompleteSignIn\b[\s\S]*\bgetAccessToken\b[\s\S]*\bsignOut as cognitoSignOut\b[\s\S]*}\s*from "\.\.\/auth-client\.mjs"/,
  );
  assert.match(
    moduleSource,
    /authMode\(\)==='cognito'\s*\?\s*await import\("\.\.\/demo-context\.mjs"\)\s*:\s*null/,
  );
  assert.match(
    moduleSource,
    /authMode\(\)==='cognito'\s*\?\s*await import\("\.\.\/hosted-persona\.mjs"\)\s*:\s*null/,
  );
});

test("the local mock server serves the authentication scripts required by the console", () => {
  assert.match(
    serverSource,
    /"\/runtime-config\.js"[\s\S]*"\/auth-client\.mjs"[\s\S]*"\/auth-core\.mjs"[\s\S]*"\/demo-assist\.mjs"[\s\S]*"\/demo-context\.mjs"[\s\S]*"\/guardrail-chain\.mjs"[\s\S]*"\/hosted-persona\.mjs"[\s\S]*\.includes\(url\.pathname\)/,
  );
  assert.match(
    serverSource,
    /readFile\(join\(__dirname, "public", url\.pathname\.slice\(1\)\), "utf8"\)/,
  );
  assert.match(
    serverSource,
    /"content-type": "text\/javascript; charset=utf-8"/,
  );
  assert.match(
    serverSource,
    /"cache-control": "no-store"/,
  );
});

test("mock persistence remains mock-only and auth headers select the correct token", () => {
  assert.match(
    moduleSource,
    /if\s*\(authMode\(\)==='mock'\)\s*try\s*{\s*SESSION=JSON\.parse\(localStorage\.getItem\(SESSION_KEY\)\)/,
  );
  assert.match(
    moduleSource,
    /function setSession\(s\)\s*{\s*SESSION=s;?\s*if\s*\(authMode\(\)!=='mock'\)return;?/,
  );

  const authHeadersSource = initializer("authHeaders", "apiBaseUrl");
  const createAuthHeaders = new Function(
    "authMode",
    "getAccessToken",
    "SESSION",
    "activeDomain",
    "demoContextHeaders",
    `return (${authHeadersSource})`,
  );

  assert.deepEqual(
    createAuthHeaders(() => "mock", () => "cognito-token", {
      token: "mock-token",
    }, () => "customer-support", () => ({
      "x-demo-role": "admin",
      "x-active-domain": "must-not-leak",
    }))(),
    {
      authorization: "Bearer mock-token",
      "x-active-domain": "customer-support",
    },
  );
  assert.deepEqual(
    createAuthHeaders(() => "cognito", () => "cognito-token", {
      token: "stale-mock-token",
      canSwitchDemoRole: true,
    }, () => "operations", () => ({
      "x-demo-role": "builder",
      "x-active-domain": "operations",
    }))(),
    {
      authorization: "Bearer cognito-token",
      "x-demo-role": "builder",
      "x-active-domain": "operations",
    },
  );
  assert.deepEqual(
    createAuthHeaders(() => "cognito", () => null, {
      token: "stale-mock-token",
    }, () => null, () => ({
      "x-demo-role": "user",
    }))(),
    {},
  );
});

test("API requests honor runtime base URLs and handle response bodies safely", () => {
  assert.match(
    moduleSource,
    /const apiBaseUrl\s*=\s*\(\)=>window\.__RUNTIME_CONFIG__\?\.apiBaseUrl\|\|'\/api'/,
  );
  assert.match(
    moduleSource,
    /const requestMethod=method\|\|\(body===undefined\?'GET':'POST'\)[\s\S]*const options=requestMethod==='GET'[\s\S]*fetch\(apiUrl\(p\),options\)/,
  );
  assert.match(
    moduleSource,
    /const text=await r\.text\(\)[\s\S]*if\(!text\)return projectRead\?{ok:r\.ok,status:r\.status}:{ok:r\.ok}/,
  );
  assert.match(
    moduleSource,
    /try\s*{\s*result=JSON\.parse\(text\)\s*}\s*catch\s*{\s*return {ok:false,error:/,
  );
});

test("Cognito login renders one focused action with escaped status", () => {
  assert.match(
    moduleSource,
    /if\(authMode\(\)==='cognito'\)\s*{[\s\S]*<button class="primary" id="cognitosignin">Sign in with Cognito<\/button>[\s\S]*<div id="loginstatus" role="status" aria-live="polite">/,
  );
  assert.match(
    moduleSource,
    /document\.getElementById\('cognitosignin'\)\.onclick=async\(\)=>{[\s\S]*await beginSignIn\(\)[\s\S]*esc\(/,
  );
  assert.match(
    moduleSource,
    /cognitoLoginStatus[\s\S]*esc\(cognitoLoginStatus\)/,
  );
});

test("all user-visible sign-out controls use the dual-mode sign-out path", () => {
  assert.match(
    moduleSource,
    /async function signOutCurrentSession\(\)\s*{[\s\S]*authMode\(\)==='cognito'[\s\S]*cognitoSignOut\(\)[\s\S]*fetch\(apiUrl\('\/logout'\),{[\s\S]*method:'POST'/,
  );
  assert.doesNotMatch(moduleSource, /id="whoami"|id="switchuser"/);
  for (const id of ["tbswitchuser", "tbsignout"]) {
    assert.match(
      moduleSource,
      new RegExp(
        `document\\.getElementById\\('${id}'\\)\\.onclick=signOutCurrentSession`,
      ),
    );
  }
});

// The hardcoded DemoPass123! fallback silently violated 14+ char pool policies;
// operators then "fixed" broken logins by resetting pool passwords ad hoc,
// breaking every other session. Pin: no hardcoded fallback, loud misconfig
// errors, and never a password reset from the console.
test("demo Cognito password comes only from cognito.env and failures are loud", () => {
  assert.doesNotMatch(serverSource, /DEMO_PW = COGNITO\.DEMO_PASSWORD \|\| "[^"]+"/);
  assert.match(serverSource, /DEMO_PW = COGNITO\.DEMO_PASSWORD \|\| ""/);
  assert.match(serverSource, /CLIENT_ID but no DEMO_PASSWORD/);
  assert.match(serverSource, /does not match the pool/);
  assert.doesNotMatch(serverSource, /admin-set-user-password/);
});
