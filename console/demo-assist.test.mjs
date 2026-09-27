import { frontendSource } from "./test-support/frontend-source.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  actionPresets,
  applyDemoAssist,
  applyPresetValue,
  availableDemoJourneys,
  clearDemoAssist,
  demoAssistEnabled,
  fieldPresets,
  getActiveDemoJourney,
  setActiveDemoJourney,
  setDemoAssistEnabled,
} from "./public/demo-assist.mjs";

const hostedHtml = frontendSource;

function installStorage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  globalThis.sessionStorage = storage;
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    } else {
      delete globalThis.sessionStorage;
    }
  });
  return storage;
}

test("authorized demo operators default enabled and keep their tab preference", (t) => {
  const storage = installStorage(t);
  const operator = { canSwitchDemoRole: true };

  assert.equal(demoAssistEnabled(operator), true);
  assert.equal(demoAssistEnabled({ canSwitchDemoRole: false }), false);

  assert.equal(setDemoAssistEnabled(operator, false), false);
  assert.equal(demoAssistEnabled(operator), false);
  assert.equal(storage.getItem("console.demo-assist"), "false");

  assert.equal(setDemoAssistEnabled(operator, true), true);
  assert.equal(demoAssistEnabled(operator), true);
  assert.equal(storage.getItem("console.demo-assist"), "true");

  clearDemoAssist();
  assert.equal(storage.getItem("console.demo-assist"), null);
});

test("available demo journeys require every enabled surface", () => {
  const ids = [
    "projects",
    "build",
    "agents",
    "registry",
    "deployments",
    "approvals",
    "domainaccess",
    "operations",
    "cost",
    "dashboard",
    "domains",
    "gateway",
    "overview",
    "approvedagents",
    "sessions",
    "accessrequests",
  ];

  assert.deepEqual(
    availableDemoJourneys(ids).map(({ id }) => id),
    ["build-agent", "govern-domain", "govern-platform", "use-approved-agent"],
  );
  assert.deepEqual(
    availableDemoJourneys(ids.slice(0, 6)).map(({ id }) => id),
    ["build-agent"],
  );
  assert.deepEqual(
    availableDemoJourneys(ids.slice(0, 5)),
    [],
  );
});

test("removing any required surface makes each journey unavailable", () => {
  const ids = [
    "projects",
    "build",
    "agents",
    "registry",
    "deployments",
    "approvals",
    "domainaccess",
    "operations",
    "cost",
    "dashboard",
    "domains",
    "registry",
    "gateway",
    "overview",
    "approvedagents",
    "sessions",
    "accessrequests",
  ];
  const requirements = [
    {
      id: "build-agent",
      requiredSurfaces: [
        "projects",
        "build",
        "agents",
        "registry",
        "deployments",
        "approvals",
      ],
    },
    {
      id: "govern-domain",
      requiredSurfaces: ["projects", "domainaccess", "approvals", "operations", "cost"],
    },
    {
      id: "govern-platform",
      requiredSurfaces: [
        "dashboard",
        "domains",
        "registry",
        "gateway",
        "approvals",
        "operations",
        "cost",
      ],
    },
    {
      id: "use-approved-agent",
      requiredSurfaces: ["overview", "approvedagents", "sessions", "accessrequests"],
    },
  ];

  for (const { id, requiredSurfaces } of requirements) {
    for (const surfaceId of requiredSurfaces) {
      const withoutSurface = ids.filter((candidate) => candidate !== surfaceId);
      assert.equal(
        availableDemoJourneys(withoutSurface).some((journey) => journey.id === id),
        false,
        `${id} must be unavailable without ${surfaceId}`,
      );
    }
  }
});

test("available journey objects are mutable and detached from the catalog", () => {
  const first = availableDemoJourneys([
    "projects",
    "build",
    "agents",
    "registry",
    "deployments",
    "approvals",
  ])[0];

  assert.equal(Object.isFrozen(first), false);
  assert.equal(Object.isFrozen(first.requiredSurfaces), false);
  assert.equal(Object.isFrozen(first.steps), false);
  assert.equal(Object.isFrozen(first.steps[0]), false);
  first.id = "changed";
  first.requiredSurfaces.push("changed");
  first.steps[0].label = "Changed";
  first.steps.pop();

  assert.deepEqual(
    availableDemoJourneys([
      "projects",
      "build",
      "agents",
      "registry",
      "deployments",
      "approvals",
    ])[0],
    {
      id: "build-agent",
      roles: ["admin", "lead", "builder"],
      label: "Build and submit an agent",
      description: "Build and submit an agent through governed platform controls.",
      requiredSurfaces: [
        "projects",
        "build",
        "agents",
        "registry",
        "deployments",
        "approvals",
      ],
      steps: [
        {
          surfaceId: "projects",
          label: "Projects",
          description: "Choose or create the governed workspace.",
        },
        {
          surfaceId: "build",
          label: "Build Agent",
          description:
            "Create, configure, test, then submit the agent to AI Registry.",
        },
          {
            surfaceId: "agents",
            label: "Agents",
            description: "Inspect the created agent and readiness state.",
          },
          {
            surfaceId: "registry",
            label: "AI Registry",
            description: "Verify the Registry record and domain approval state.",
          },
          {
            surfaceId: "deployments",
          label: "Deployments",
          description: "Verify sandbox or production submission state.",
        },
        {
          surfaceId: "approvals",
          label: "Approvals",
          description: "Track the domain approval request.",
        },
      ],
    },
  );
});

test("authorized operators can set and read a bounded active journey", (t) => {
  const storage = installStorage(t);
  const operator = { canSwitchDemoRole: true };

  assert.deepEqual(
    setActiveDemoJourney(operator, { journeyId: "build-agent", step: 4 }),
    { journeyId: "build-agent", step: 4 },
  );
  assert.deepEqual(getActiveDemoJourney(operator), {
    journeyId: "build-agent",
    step: 4,
  });
  assert.equal(
    storage.getItem("console.demo-assist.journey"),
    '{"journeyId":"build-agent","step":4}',
  );
});

test("active journey activation fails closed when tab storage is unavailable", (t) => {
  const storage = installStorage(t);
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };

  assert.equal(
    setActiveDemoJourney(
      { canSwitchDemoRole: true },
      { journeyId: "build-agent", step: 0 },
    ),
    null,
  );
  assert.equal(storage.getItem("console.demo-assist.journey"), null);
});

test("unauthorized operators cannot read or set an active journey", (t) => {
  const storage = installStorage(t);
  storage.setItem(
    "console.demo-assist.journey",
    '{"journeyId":"build-agent","step":0}',
  );
  assert.equal(getActiveDemoJourney({ canSwitchDemoRole: false }), null);
  assert.equal(
    setActiveDemoJourney(
      { canSwitchDemoRole: false },
      { journeyId: "build-agent", step: 0 },
    ),
    null,
  );
  assert.equal(
    storage.getItem("console.demo-assist.journey"),
    '{"journeyId":"build-agent","step":0}',
  );
});

test("invalid active journey values are rejected and cleared", (t) => {
  const storage = installStorage(t);
  const operator = { canSwitchDemoRole: true };
  const invalidValues = [
    { journeyId: "unknown", step: 0 },
    { journeyId: "build-agent", step: 0, extra: true },
    { journeyId: "build-agent", step: 1.5 },
    { journeyId: "build-agent", step: 6 },
  ];

  for (const value of invalidValues) {
    storage.setItem("console.demo-assist.journey", JSON.stringify(value));
    assert.equal(getActiveDemoJourney(operator), null);
    assert.equal(storage.getItem("console.demo-assist.journey"), null);
  }
});

test("setActiveDemoJourney rejects invalid values and preserves valid state", (t) => {
  const storage = installStorage(t);
  const operator = { canSwitchDemoRole: true };
  const invalidValues = [
    { journeyId: "unknown", step: 0 },
    { journeyId: "build-agent", step: 0, extra: true },
    { journeyId: "build-agent", step: 1.5 },
    { journeyId: "build-agent", step: 6 },
  ];

  for (const value of invalidValues) {
    storage.setItem(
      "console.demo-assist.journey",
      '{"journeyId":"build-agent","step":0}',
    );
    assert.equal(setActiveDemoJourney(operator, value), null);
    assert.equal(
      storage.getItem("console.demo-assist.journey"),
      '{"journeyId":"build-agent","step":0}',
    );
  }
});

test("malformed active journey JSON is rejected and cleared on read", (t) => {
  const storage = installStorage(t);
  storage.setItem("console.demo-assist.journey", "{not-json");

  assert.equal(getActiveDemoJourney({ canSwitchDemoRole: true }), null);
  assert.equal(storage.getItem("console.demo-assist.journey"), null);
});

test("clearing demo assist also clears the active journey", (t) => {
  const storage = installStorage(t);
  const operator = { canSwitchDemoRole: true };

  setActiveDemoJourney(operator, { journeyId: "build-agent", step: 0 });
  clearDemoAssist();

  assert.equal(storage.getItem("console.demo-assist.journey"), null);
  assert.equal(getActiveDemoJourney(operator), null);
});

test("generic presets cover hosted journeys without real identifiers", () => {
  assert.deepEqual(fieldPresets("projectId"), ["release-review"]);
  assert.deepEqual(fieldPresets("resourceId"), ["release-evidence-tool"]);
  assert.deepEqual(fieldPresets("agentId"), ["release-coordinator"]);
  assert.deepEqual(fieldPresets("incidentTitle"), [
    "Release validation delay",
    "Service response degradation",
  ]);
  assert.deepEqual(fieldPresets("haccesssubject"), []);

  const serialized = JSON.stringify([
    fieldPresets("projectId"),
    fieldPresets("resourceId"),
    fieldPresets("agentId"),
    fieldPresets("breakGlassResource"),
  ]);
  assert.doesNotMatch(serialized, /@|\.com|customer|example|[0-9]{12}/i);
});

test("portable field presets cover remaining hosted Cognito business inputs", () => {
  const expected = {
    repositoryName: [
      "release-coordinator",
      "service-intake-helper",
    ],
    agentInstructions: [
      "Summarize approved release evidence and identify the next governed step.",
      "Classify the request and explain the approved handoff path.",
    ],
    modelTemperature: ["0.2", "0.4"],
    modelMaxTokens: ["1024", "2048"],
    specDiscoveryResponse: [
      "Support staff need a read-only assistant that triages release evidence.",
      "The agent should use approved records and explain when evidence is incomplete.",
      "The experience is web-based and must preserve the governed approval path.",
    ],
    gatewayDecisionReason: [
      "Approve bounded model access for the reviewed workflow.",
      "Reject access until the required review is complete.",
    ],
    gatewayRequestsPerMinute: ["60", "120"],
    gatewayTokensPerMinute: ["120000", "240000"],
    gatewayConnectionsPerSecond: ["4", "8"],
    domainAccessReason: [
      "Support the approved domain workflow.",
      "Provide time-bound access for a reviewed task.",
    ],
    projectAccessReason: [
      "Support the approved project workflow.",
      "Provide time-bound project access for a reviewed task.",
    ],
    accessGrantReason: [
      "Grant access for the approved production workflow.",
      "Provide reviewed access within the selected scope.",
    ],
    experiencePrompt: [
      "Summarize the current status and recommend the next approved action.",
      "Explain the governed handoff for this request.",
    ],
    experienceFeedbackComment: [
      "The response was clear and supported the approved workflow.",
      "The response needs a more specific next action.",
    ],
    experienceIssueDescription: [
      "The response omitted the requested approval context.",
      "The response did not include the expected governed next step.",
    ],
    requestableAgentReason: [
      "Access is required for a reviewed business workflow.",
      "Access is needed to complete an approved task.",
    ],
    domainName: ["Release Operations", "Service Intake"],
    domainMonthlyTokenBudget: ["500000", "1000000"],
    domainDescription: [
      "Coordinates governed release operations.",
      "Supports reviewed service intake workflows.",
    ],
  };

  for (const [field, values] of Object.entries(expected)) {
    assert.deepEqual(fieldPresets(field), values, field);
  }
});

test("identity, live selection, time, search, credential, and confirmation fields have no presets", () => {
  for (const field of [
    "username",
    "haccessdomainusername",
    "haccessproject",
    "haccessprojectusername",
    "haccesssubjecttype",
    "principal",
    "haccesssubject",
    "subject",
    "haccessexpires",
    "expiry",
    "datetime",
    "downer",
    "owner",
    "dgroup",
    "cognitoGroup",
    "regsearch",
    "wsswitchsearch",
    "filter",
    "secret",
    "credential",
    "pghorg",
    "pghrepo",
    "pconfirmreal",
    "repositoryOwner",
    "exactConfirmation",
  ]) {
    assert.deepEqual(fieldPresets(field), [], field);
  }
});


test("break-glass field presets use the same semantic keys as its scenario", () => {
  assert.deepEqual(fieldPresets("breakGlassResource"), [
    "trace/release-review/sample",
    "audit/release-review/summary",
  ]);
  assert.deepEqual(fieldPresets("breakGlassAction"), [
    "trace:read-content",
    "audit:review",
  ]);
  assert.deepEqual(fieldPresets("breakGlassReason"), [
    "Investigate a time-sensitive release validation issue.",
    "Review an active operational impact with time-bound access.",
  ]);
});

test("preset application dispatches ordinary events without submitting a form", () => {
  const events = [];
  let submitted = false;
  const control = {
    value: "",
    form: {
      requestSubmit() {
        submitted = true;
      },
      submit() {
        submitted = true;
      },
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
  applyPresetValue(control, "Release validation delay");

  assert.equal(control.value, "Release validation delay");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(submitted, false);
});

function demoTextFixture({
  field,
  value = "",
  explicitChoice,
  placeholder = "",
}) {
  const events = [];
  let selector = null;
  const control = {
    tagName: "INPUT",
    type: "text",
    value,
    className: "",
    hidden: false,
    disabled: false,
    placeholder: "",
    dataset: {
      demoAssistField: field,
      ...(explicitChoice
        ? { demoAssistExplicitChoice: explicitChoice }
        : {}),
      ...(placeholder
        ? { demoAssistPlaceholder: placeholder }
        : {}),
    },
    style: { cssText: "" },
    getAttribute() {
      return null;
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
    insertAdjacentElement(_position, element) {
      selector = element;
    },
  };
  const document = {
    createElement(tagName) {
      if (tagName === "option") {
        return {
          value: "",
          textContent: "",
          selected: false,
        };
      }
      const listeners = new Map();
      return {
        tagName: "SELECT",
        value: "",
        options: [],
        className: "",
        disabled: false,
        dataset: {},
        style: { cssText: "" },
        append(option) {
          this.options.push(option);
          if (option.selected || this.options.length === 1) {
            this.value = option.value;
          }
        },
        setAttribute() {},
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        change(value) {
          this.value = value;
          listeners.get("change")?.();
        },
      };
    },
  };
  const root = {
    ownerDocument: document,
    querySelectorAll(selectorText) {
      if (selectorText === "input,textarea") return [control];
      return [];
    },
  };
  return {
    control,
    events,
    root,
    selector: () => selector,
  };
}

test("delivery confirmation selector starts blank and requires the exact repository name", () => {
  const expected = "release-coordinator";
  const fixture = demoTextFixture({
    field: "deliveryConfirmation",
    explicitChoice: expected,
    placeholder: "Select the exact repository name to approve",
  });

  applyDemoAssist(fixture.root, true);
  const selector = fixture.selector();

  assert.equal(fixture.control.hidden, true);
  assert.equal(fixture.control.value, "");
  assert.equal(selector.value, "");
  assert.deepEqual(
    selector.options.map(({ value, textContent }) => ({ value, textContent })),
    [
      {
        value: "",
        textContent: "Select the exact repository name to approve",
      },
      { value: expected, textContent: expected },
    ],
  );

  selector.change(expected);

  assert.equal(fixture.control.value, expected);
  assert.deepEqual(fixture.events, ["input", "change"]);
});

test("guardrail message selector preserves an intentional empty value", () => {
  const fixture = demoTextFixture({ field: "guardrailMessage" });

  applyDemoAssist(fixture.root, true);
  const selector = fixture.selector();

  assert.equal(fixture.control.value, "");
  assert.equal(selector.value, "");
  assert.deepEqual(
    selector.options[0],
    {
      value: "",
      textContent: "No custom message",
      selected: true,
    },
  );
});

test("preset application accepts DOM-like controls with inherited value properties", () => {
  const events = [];
  const control = Object.create({ value: "" });
  control.dispatchEvent = (event) => {
    events.push(event.type);
    return true;
  };

  assert.equal(applyPresetValue(control, "Service Intake"), true);
  assert.equal(control.value, "Service Intake");
  assert.deepEqual(events, ["input", "change"]);
});

test("Demo action dialogs expose predefined choices instead of free text", () => {
  assert.deepEqual(actionPresets("approvalRejection"), [
    "Reject until the required governance evidence is complete.",
    "Reject because the request is outside the approved domain scope.",
  ]);
  assert.deepEqual(actionPresets("projectRole"), [
    "builder",
    "owner",
  ]);
  assert.deepEqual(actionPresets("unknown"), []);
});
