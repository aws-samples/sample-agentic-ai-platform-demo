const STORAGE_KEY = "console.demo-assist";
const JOURNEY_STORAGE_KEY = "console.demo-assist.journey";

const JOURNEYS = Object.freeze([
  Object.freeze({
    id: "build-agent",
    roles: Object.freeze(["admin", "lead", "builder"]),
    label: "Build and submit an agent",
    description: "Build and submit an agent through governed platform controls.",
    requiredSurfaces: Object.freeze([
      "projects",
      "build",
      "agents",
      "registry",
      "deployments",
      "approvals",
    ]),
    steps: Object.freeze([
      Object.freeze({
        surfaceId: "projects",
        label: "Projects",
        description: "Choose or create the governed workspace.",
      }),
      Object.freeze({
        surfaceId: "build",
        label: "Build Agent",
        description:
          "Create, configure, test, then submit the agent to AI Registry.",
      }),
      Object.freeze({
        surfaceId: "agents",
        label: "Agents",
        description: "Inspect the created agent and readiness state.",
      }),
      Object.freeze({
        surfaceId: "registry",
        label: "AI Registry",
        description: "Verify the Registry record and domain approval state.",
      }),
      Object.freeze({
        surfaceId: "deployments",
        label: "Deployments",
        description: "Verify sandbox or production submission state.",
      }),
      Object.freeze({
        surfaceId: "approvals",
        label: "Approvals",
        description: "Track the domain approval request.",
      }),
    ]),
  }),
  Object.freeze({
    id: "govern-domain",
    roles: Object.freeze(["lead"]),
    label: "Govern a domain",
    description: "Govern domain access, approvals, operations, and cost.",
    requiredSurfaces: Object.freeze([
      "projects",
      "domainaccess",
      "approvals",
      "operations",
      "cost",
    ]),
    steps: Object.freeze([
      Object.freeze({
        surfaceId: "projects",
        label: "Projects",
        description: "Review domain workspaces.",
      }),
      Object.freeze({
        surfaceId: "domainaccess",
        label: "Users & Access",
        description: "Manage bounded domain and project access.",
      }),
      Object.freeze({
        surfaceId: "approvals",
        label: "Approvals",
        description: "Decide domain-owned requests.",
      }),
      Object.freeze({
        surfaceId: "operations",
        label: "Operations",
        description: "Inspect domain health and incidents.",
      }),
      Object.freeze({
        surfaceId: "cost",
        label: "Cost",
        description: "Review domain consumption.",
      }),
    ]),
  }),
  Object.freeze({
    id: "govern-platform",
    roles: Object.freeze(["admin"]),
    label: "Govern the platform",
    description: "Govern platform inventory, access, operations, and cost.",
    requiredSurfaces: Object.freeze([
      "dashboard",
      "domains",
      "registry",
      "gateway",
      "approvals",
      "operations",
      "cost",
    ]),
    steps: Object.freeze([
      Object.freeze({
        surfaceId: "dashboard",
        label: "Dashboard",
        description: "Review platform-wide inventory.",
      }),
      Object.freeze({
        surfaceId: "domains",
        label: "Domains",
        description: "Inspect governance boundaries.",
      }),
      Object.freeze({
        surfaceId: "registry",
        label: "AI Registry",
        description: "Review governed reusable resources.",
      }),
      Object.freeze({
        surfaceId: "gateway",
        label: "AI Gateway",
        description: "Inspect models, access policy, and rate limits.",
      }),
      Object.freeze({
        surfaceId: "approvals",
        label: "Approvals",
        description: "Review platform-owned requests.",
      }),
      Object.freeze({
        surfaceId: "operations",
        label: "Operations",
        description: "Inspect aggregate operational posture.",
      }),
      Object.freeze({
        surfaceId: "cost",
        label: "Cost",
        description: "Review platform consumption.",
      }),
    ]),
  }),
  Object.freeze({
    id: "use-approved-agent",
    roles: Object.freeze(["user"]),
    label: "Use an approved agent",
    description: "Use an approved agent and review its governed experience.",
    requiredSurfaces: Object.freeze([
      "overview",
      "approvedagents",
      "sessions",
      "accessrequests",
    ]),
    steps: Object.freeze([
      Object.freeze({
        surfaceId: "overview",
        label: "Overview",
        description: "Review the entitled experience.",
      }),
      Object.freeze({
        surfaceId: "approvedagents",
        label: "Approved Agents",
        description: "Select and invoke an approved agent.",
      }),
      Object.freeze({
        surfaceId: "sessions",
        label: "Sessions",
        description: "Inspect your own conversation history.",
      }),
      Object.freeze({
        surfaceId: "accessrequests",
        label: "Access Requests",
        description: "Track requests for additional agents.",
      }),
    ]),
  }),
]);

const FIELD_PRESETS = Object.freeze({
  projectId: Object.freeze([
    "release-review",
  ]),
  projectName: Object.freeze([
    "Release Review",
    "Service Intake",
  ]),
  projectDescription: Object.freeze([
    "Coordinates a governed release-readiness review.",
    "Routes a shared operational intake through approved controls.",
  ]),
  governanceName: Object.freeze([
    "Release Evidence Tool",
    "Service Intake Guide",
  ]),
  resourceId: Object.freeze([
    "release-evidence-tool",
  ]),
  governanceVersion: Object.freeze([
    "1.0.0",
    "1.1.0",
  ]),
  governanceDescription: Object.freeze([
    "Summarizes approved release evidence for a governed workflow.",
    "Provides a reusable intake pattern with bounded guidance.",
  ]),
  governanceSpecification: Object.freeze([
    '{"input":"release evidence","output":"review summary"}',
    '{"input":"service request","output":"intake guidance"}',
  ]),
  agentName: Object.freeze([
    "Release Coordinator",
    "Service Intake Helper",
  ]),
  agentId: Object.freeze([
    "release-coordinator",
  ]),
  agentDescription: Object.freeze([
    "Coordinates governed release-readiness tasks.",
    "Guides a bounded operational intake workflow.",
  ]),
  agentPrompt: Object.freeze([
    "Summarize approved release evidence and identify the next governed step.",
    "Classify the request and explain the approved handoff path.",
  ]),
  repositoryName: Object.freeze([
    "release-coordinator",
    "service-intake-helper",
  ]),
  agentInstructions: Object.freeze([
    "Summarize approved release evidence and identify the next governed step.",
    "Classify the request and explain the approved handoff path.",
  ]),
  modelTemperature: Object.freeze([
    "0.2",
    "0.4",
  ]),
  modelMaxTokens: Object.freeze([
    "1024",
    "2048",
  ]),
  guardrailMessage: Object.freeze([
    "This request is blocked by the platform safety policy.",
    "This response was flagged for domain review.",
    "",
  ]),
  specDiscoveryResponse: Object.freeze([
    "Support staff need a read-only assistant that triages release evidence.",
    "The agent should use approved records and explain when evidence is incomplete.",
    "The experience is web-based and must preserve the governed approval path.",
  ]),
  incidentTitle: Object.freeze([
    "Release validation delay",
    "Service response degradation",
  ]),
  incidentDescription: Object.freeze([
    "Validation evidence is delayed and release readiness needs review.",
    "Response quality has degraded and requires coordinated investigation.",
  ]),
  incidentReason: Object.freeze([
    "Coordinate the incident response.",
    "Record the initial mitigation plan.",
  ]),
  breakGlassResource: Object.freeze([
    "trace/release-review/sample",
    "audit/release-review/summary",
  ]),
  breakGlassAction: Object.freeze([
    "trace:read-content",
    "audit:review",
  ]),
  breakGlassReason: Object.freeze([
    "Investigate a time-sensitive release validation issue.",
    "Review an active operational impact with time-bound access.",
  ]),
  gatewayDecisionReason: Object.freeze([
    "Approve bounded model access for the reviewed workflow.",
    "Reject access until the required review is complete.",
  ]),
  gatewayRequestsPerMinute: Object.freeze([
    "60",
    "120",
  ]),
  gatewayTokensPerMinute: Object.freeze([
    "120000",
    "240000",
  ]),
  gatewayConnectionsPerSecond: Object.freeze([
    "4",
    "8",
  ]),
  domainAccessReason: Object.freeze([
    "Support the approved domain workflow.",
    "Provide time-bound access for a reviewed task.",
  ]),
  projectAccessReason: Object.freeze([
    "Support the approved project workflow.",
    "Provide time-bound project access for a reviewed task.",
  ]),
  accessGrantReason: Object.freeze([
    "Grant access for the approved production workflow.",
    "Provide reviewed access within the selected scope.",
  ]),
  experiencePrompt: Object.freeze([
    "Summarize the current status and recommend the next approved action.",
    "Explain the governed handoff for this request.",
  ]),
  experienceFeedbackComment: Object.freeze([
    "The response was clear and supported the approved workflow.",
    "The response needs a more specific next action.",
  ]),
  experienceIssueDescription: Object.freeze([
    "The response omitted the requested approval context.",
    "The response did not include the expected governed next step.",
  ]),
  requestableAgentReason: Object.freeze([
    "Access is required for a reviewed business workflow.",
    "Access is needed to complete an approved task.",
  ]),
  domainName: Object.freeze([
    "Release Operations",
    "Service Intake",
  ]),
  domainMonthlyTokenBudget: Object.freeze([
    "500000",
    "1000000",
  ]),
  domainDescription: Object.freeze([
    "Coordinates governed release operations.",
    "Supports reviewed service intake workflows.",
  ]),
});

const CONTROL_PRESETS = Object.freeze({
  downer: Object.freeze([
    "Release Operations team",
    "Service Intake team",
  ]),
  dgroup: Object.freeze([
    "domain-release-operations",
    "domain-service-intake",
  ]),
  regsearch: Object.freeze([
    "Agent",
    "Model",
    "Blueprint",
  ]),
});

const ACTION_PRESETS = Object.freeze({
  approvalRejection: Object.freeze([
    "Reject until the required governance evidence is complete.",
    "Reject because the request is outside the approved domain scope.",
  ]),
  incidentAction: Object.freeze([
    "Record the reviewed incident transition.",
    "Apply the approved operational response.",
  ]),
  breakGlassDecision: Object.freeze([
    "Record the reviewed emergency-access decision.",
    "Reject until the emergency-access evidence is complete.",
  ]),
  breakGlassActivation: Object.freeze([
    "Activate the approved time-bound emergency access.",
    "Begin the reviewed incident investigation.",
  ]),
  breakGlassRevocation: Object.freeze([
    "Revoke access after the investigation is complete.",
    "Revoke access because the approved window has ended.",
  ]),
  modelAccess: Object.freeze([
    "Use the model for an approved domain workflow.",
    "Evaluate the model within the reviewed project scope.",
  ]),
  projectRole: Object.freeze([
    "builder",
    "owner",
  ]),
});

function cloneJourney(journey) {
  return {
    ...journey,
    roles: [...journey.roles],
    requiredSurfaces: [...journey.requiredSurfaces],
    steps: journey.steps.map((step) => ({ ...step })),
  };
}

function journeyById(journeyId) {
  return JOURNEYS.find((journey) => journey.id === journeyId);
}

function validActiveJourney(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "journeyId,step") return false;
  const journey = journeyById(value.journeyId);
  return !!journey
    && Number.isInteger(value.step)
    && value.step >= 0
    && value.step < journey.steps.length;
}

export function availableDemoJourneys(surfaceIds, role = null) {
  const available = new Set(surfaceIds);
  return JOURNEYS
    .filter(({ requiredSurfaces, roles }) =>
      (!role || roles.includes(role)) && requiredSurfaces.every((id) => available.has(id)))
    .map(cloneJourney);
}

export function getActiveDemoJourney(profile) {
  if (profile?.canSwitchDemoRole !== true) return null;
  try {
    const stored = sessionStorage.getItem(JOURNEY_STORAGE_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored);
    if (!validActiveJourney(value)) {
      sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
      return null;
    }
    return { journeyId: value.journeyId, step: value.step };
  } catch {
    try {
      sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
    } catch {}
    return null;
  }
}

export function setActiveDemoJourney(profile, value) {
  if (profile?.canSwitchDemoRole !== true) {
    return null;
  }
  if (!validActiveJourney(value)) {
    return null;
  }
  const active = { journeyId: value.journeyId, step: value.step };
  try {
    sessionStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(active));
  } catch {
    return null;
  }
  return active;
}

export function clearActiveDemoJourney() {
  try {
    sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
  } catch {}
}

export function demoAssistEnabled(profile) {
  if (profile?.canSwitchDemoRole !== true) return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setDemoAssistEnabled(profile, enabled) {
  if (profile?.canSwitchDemoRole !== true) return false;
  const value = enabled === true;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(value));
  } catch {}
  return value;
}

export function clearDemoAssist() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
  clearActiveDemoJourney();
}

export function fieldPresets(field) {
  return [...(FIELD_PRESETS[field] || [])];
}

export function actionPresets(action) {
  return [...(ACTION_PRESETS[action] || [])];
}

function isDemoTextControl(control) {
  const tagName = String(control?.tagName || "").toUpperCase();
  if (tagName === "TEXTAREA") return true;
  if (tagName !== "INPUT") return false;
  return !new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]).has(String(control.type || "text").toLowerCase());
}

function demoSelectorValues({
  explicitChoice,
  field,
  id,
  value,
  liveValues = [],
} = {}) {
  return [...new Set([
    value,
    explicitChoice,
    ...liveValues,
    ...fieldPresets(field),
    ...(CONTROL_PRESETS[id] || []),
  ].map((item) => String(item || "").trim()).filter(Boolean))];
}

export function applyPresetValue(control, value) {
  if (!control || !("value" in Object(control))) return false;
  control.value = String(value);
  control.dispatchEvent?.(new Event("input", { bubbles: true }));
  control.dispatchEvent?.(new Event("change", { bubbles: true }));
  return true;
}

function liveValuesFor(control, root) {
  const values = [];
  const memberSelectors = {
    haccessdomainusername: ["[data-domain-member]"],
    haccessprojectusername: ["[data-domain-member]", "[data-project-member]"],
  }[control.id] || [];
  for (const selector of memberSelectors) {
    for (const node of root.querySelectorAll(selector)) {
      values.push(node.getAttribute(selector.slice(1, -1)));
    }
  }
  if (String(control.type).toLowerCase() === "datetime-local") {
    for (const hours of [1, 24]) {
      values.push(new Date(Date.now() + hours * 60 * 60 * 1000)
        .toISOString().slice(0, 16));
    }
  }
  return values;
}

function restoreTextControls(root) {
  for (const control of root.querySelectorAll("[data-demo-assist-source]")) {
    control.hidden = control.dataset.demoAssistWasHidden === "true";
    delete control.dataset.demoAssistSource;
    delete control.dataset.demoAssistWasHidden;
  }
  root.querySelectorAll("[data-demo-assist-controls]")
    .forEach((node) => node.remove());
}

function addTextSelectors(root, doc) {
  for (const control of root.querySelectorAll("input,textarea")) {
    if (!isDemoTextControl(control)) continue;
    const field = control.dataset.demoAssistField;
    const explicitChoice = control.dataset.demoAssistExplicitChoice;
    const preservesEmpty = field === "guardrailMessage";
    const values = demoSelectorValues({
      explicitChoice,
      field,
      id: control.id,
      value: control.value,
      liveValues: liveValuesFor(control, root),
    });
    const select = doc.createElement("select");
    select.className = `${control.className || ""} demo-assist-selector`.trim();
    select.style.cssText = control.style?.cssText || "";
    select.dataset.demoAssistControls = "";
    select.setAttribute(
      "aria-label",
      control.getAttribute("aria-label")
        || control.placeholder
        || (field ? `Demo value for ${field}` : "Predefined demo value"),
    );
    if (values.length || preservesEmpty) {
      if (explicitChoice) {
        const placeholder = doc.createElement("option");
        placeholder.value = "";
        placeholder.textContent = control.dataset.demoAssistPlaceholder
          || "Select a demo value";
        placeholder.selected = true;
        select.append(placeholder);
      } else if (preservesEmpty) {
        const empty = doc.createElement("option");
        empty.value = "";
        empty.textContent = "No custom message";
        empty.selected = String(control.value || "").trim() === "";
        select.append(empty);
      }
      for (const value of values) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = value;
        select.append(option);
      }
      select.value = explicitChoice
        ? ""
        : (
            preservesEmpty && String(control.value || "").trim() === ""
              ? ""
              : String(control.value || "").trim() || values[0]
          );
      if (control.value === select.value) {
        control.value = select.value;
      } else {
        applyPresetValue(control, select.value);
      }
      select.addEventListener("change", () => {
        applyPresetValue(control, select.value);
      });
    } else {
      const option = doc.createElement("option");
      option.textContent = "No predefined demo value available";
      select.append(option);
      select.disabled = true;
    }
    select.disabled ||= control.disabled;
    control.dataset.demoAssistSource = "";
    control.dataset.demoAssistWasHidden = String(control.hidden);
    control.hidden = true;
    control.insertAdjacentElement("afterend", select);
  }
}

export function applyDemoAssist(root, enabled) {
  if (!root?.querySelectorAll) return;
  restoreTextControls(root);
  if (enabled !== true) return;
  const doc = root.ownerDocument || document;
  addTextSelectors(root, doc);
}
