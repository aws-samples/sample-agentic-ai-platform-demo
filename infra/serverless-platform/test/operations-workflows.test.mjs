import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationsServiceError,
  createOperationsService,
} from "../lambda/operations/service.mjs";

const NOW = Date.parse("2026-08-25T02:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const admin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["customer_support", "operations"],
});
const lead = Object.freeze({
  actor: "lead-sub",
  role: "lead",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const builder = Object.freeze({
  actor: "builder-sub",
  role: "builder",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "incident-001",
    title: "Elevated agent failures",
    description: "The support agent is returning an elevated error rate.",
    severity: "HIGH",
    status: "OPEN",
    ownerSubject: "builder-sub",
    reporterSubject: "builder-sub",
    acknowledgedBySubject: null,
    acknowledgedAt: null,
    resolvedBySubject: null,
    resolvedAt: null,
    reopenedBySubject: null,
    reopenedAt: null,
    lastActionReason: "Reported after runtime alert validation.",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function breakGlass(overrides = {}) {
  return {
    id: "break-glass-001",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "trace/customer_support/case-assist/trace-001",
    action: "trace:read-content",
    status: "REQUESTED",
    requesterSubject: "admin-sub",
    reason: "Investigate a critical production incident.",
    requestedAt: NOW_ISO,
    expiresAt: "2026-08-25T02:30:00.000Z",
    approverSubject: null,
    decisionReason: null,
    decidedAt: null,
    activatedBySubject: null,
    activationReason: null,
    activatedAt: null,
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function audit(overrides = {}) {
  return {
    resource: "incident/customer_support/case-assist/incident-001",
    timestamp: NOW_ISO,
    requestId: "incident-request-001",
    actor: "lead-sub",
    requesterSubject: "builder-sub",
    effectiveRole: "lead",
    action: "incident.update",
    decision: "acknowledge",
    reason: "Response ownership accepted.",
    domainId: "customer_support",
    projectId: "case-assist",
    ...overrides,
  };
}

function page(items = [], cursor = null) {
  return { items, cursor };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof OperationsServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

function harness({
  audits = [audit()],
  authorize = async () => ({ ok: true }),
  breakGlassRecords = [breakGlass()],
  completedMutations = [],
  incidents = [incident()],
  projects = [project()],
  now = NOW,
  workspaceOverrides = {},
} = {}) {
  const calls = [];
  const currentTime = () => typeof now === "function" ? now() : now;
  const incidentRecords = new Map(
    incidents.map((record) => [
      `${record.domainId}/${record.id}`,
      structuredClone(record),
    ]),
  );
  const grants = new Map(
    breakGlassRecords.map((record) => [
      record.id,
      structuredClone(record),
    ]),
  );
  const mutationResults = new Map(
    completedMutations.map((record) => [
      `${record.actor}/${record.route}/${record.requestId}`,
      structuredClone(record),
    ]),
  );
  const workspaceState = {
    beginTransaction() {
      calls.push(["beginTransaction"]);
      const value = currentTime();
      return Object.freeze({
        timestamp: new Date(value).toISOString(),
        epochSeconds: Math.floor(value / 1000),
      });
    },
    async listProjects(input) {
      calls.push(["listProjects", input]);
      return page(projects.filter(
        ({ domainId }) => domainId === input.domainId,
      ));
    },
    async getProject(input) {
      calls.push(["getProject", input]);
      return projects.find(
        ({ domainId, id }) =>
          domainId === input.domainId && id === input.projectId,
      ) ?? null;
    },
    async listIncidents(input) {
      calls.push(["listIncidents", input]);
      return page([...incidentRecords.values()].filter((record) =>
        record.domainId === input.domainId
        && (
          input.ownerSubject === undefined
          || record.ownerSubject === input.ownerSubject
        )));
    },
    async getIncident(input) {
      calls.push(["getIncident", input]);
      return incidentRecords.get(
        `${input.domainId}/${input.incidentId}`,
      ) ?? null;
    },
    async putIncident(input) {
      calls.push(["putIncident", structuredClone(input)]);
      incidentRecords.set(
        `${input.record.domainId}/${input.record.id}`,
        structuredClone(input.record),
      );
      mutationResults.set(
        `${input.mutation.actor}/${input.mutation.route}/${input.mutation.requestId}`,
        structuredClone(input.mutation),
      );
      return input.record;
    },
    async listAuditMetadata(input) {
      calls.push(["listAuditMetadata", input]);
      return page(audits.filter((record) =>
        input.domainId === undefined
        || record.domainId === input.domainId));
    },
    async listBreakGlass(input) {
      calls.push(["listBreakGlass", input]);
      return page([...grants.values()].filter((record) =>
        input.requesterSubject === undefined
        || record.requesterSubject === input.requesterSubject));
    },
    async getBreakGlass(input) {
      calls.push(["getBreakGlass", input]);
      return grants.get(input.breakGlassId) ?? null;
    },
    async putBreakGlass(input) {
      calls.push(["putBreakGlass", structuredClone(input)]);
      grants.set(input.record.id, structuredClone(input.record));
      mutationResults.set(
        `${input.mutation.actor}/${input.mutation.route}/${input.mutation.requestId}`,
        structuredClone(input.mutation),
      );
      return input.record;
    },
    async getMutationResult(input) {
      calls.push(["getMutationResult", structuredClone(input)]);
      return mutationResults.get(
        `${input.actor}/${input.route}/${input.requestId}`,
      ) ?? null;
    },
    ...workspaceOverrides,
  };
  const service = createOperationsService({
    workspaceState,
    authorizer: async (input) => {
      calls.push(["authorize", input]);
      return authorize(input);
    },
    cloudWatchProvider: {
      async listRuntimeAggregates() {
        return page();
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page();
      },
      async listBudgets() {
        return [];
      },
    },
    clock: currentTime,
    cursorSigningKey:
      "test-only-operations-workflow-signing-key-material",
  });
  return {
    calls,
    grants,
    incidentRecords,
    mutationResults,
    service,
  };
}

test("audit metadata is platform-scoped for Admin, domain-scoped for Lead, and denied to Builder", async () => {
  const { calls, service } = harness({
    audits: [
      audit(),
      audit({
        resource: "incident/operations/ops/incident-002",
        domainId: "operations",
        projectId: "ops",
      }),
    ],
  });

  const adminResult = await service.listAudit({
    identity: admin,
    limit: 20,
  });
  assert.equal(adminResult.items.length, 2);
  assert.deepEqual(adminResult.scope, { type: "platform" });
  assert.equal(JSON.stringify(adminResult).includes("tracePayload"), false);

  const leadResult = await service.listAudit({
    identity: lead,
    limit: 20,
  });
  assert.deepEqual(leadResult.items, [audit()]);
  assert.deepEqual(leadResult.scope, {
    type: "domain",
    domainId: "customer_support",
  });
  assert.ok(calls.some(
    ([name, input]) =>
      name === "listAuditMetadata"
      && input.domainId === "customer_support",
  ));

  await assert.rejects(
    service.listAudit({ identity: builder, limit: 20 }),
    expectCode("FORBIDDEN"),
  );
});

test("audit metadata rejects trace-shaped storage records", async () => {
  const { service } = harness({
    audits: [{ ...audit(), tracePayload: "protected-content" }],
  });

  await assert.rejects(
    service.listAudit({ identity: admin, limit: 20 }),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("audit cursors are opaque, signed, and bound to the caller and limit", async () => {
  const firstCursor = {
    pk: "AUDIT#incident/customer_support/case-assist/incident-001",
    sk: `${NOW_ISO}#incident-request-001`,
  };
  const seen = [];
  const { service } = harness({
    workspaceOverrides: {
      async listAuditMetadata(input) {
        seen.push(structuredClone(input));
        return seen.length === 1
          ? page([audit()], firstCursor)
          : page([audit({
              requestId: "incident-request-002",
              timestamp: "2026-08-25T02:01:00.000Z",
            })]);
      },
    },
  });

  const first = await service.listAudit({
    identity: admin,
    limit: 1,
  });
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/);

  const second = await service.listAudit({
    identity: admin,
    limit: 1,
    cursor: first.cursor,
  });
  assert.equal(second.items[0].requestId, "incident-request-002");
  assert.deepEqual(seen[1].cursor, firstCursor);
  assert.equal(second.cursor, null);

  await assert.rejects(
    service.listAudit({
      identity: lead,
      limit: 1,
      cursor: first.cursor,
    }),
    expectCode("NOT_FOUND"),
  );
  const tampered = `${first.cursor.slice(0, -1)}${
    first.cursor.endsWith("A") ? "B" : "A"
  }`;
  await assert.rejects(
    service.listAudit({
      identity: admin,
      limit: 1,
      cursor: tampered,
    }),
    expectCode("NOT_FOUND"),
  );
});

test("workflow reads reject lifecycle-inconsistent storage records", async () => {
  const malformedIncident = harness({
    incidents: [incident({ status: "ACKNOWLEDGED" })],
  });
  await assert.rejects(
    malformedIncident.service.listIncidents({
      identity: lead,
      limit: 20,
    }),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );

  const malformedBreakGlass = harness({
    breakGlassRecords: [breakGlass({ status: "ACTIVE" })],
  });
  await assert.rejects(
    malformedBreakGlass.service.listBreakGlass({
      identity: admin,
      limit: 20,
    }),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("incident visibility is Admin all, Lead domain, and Builder owned-project only", async () => {
  const records = [
    incident(),
    incident({
      id: "incident-foreign-owner",
      ownerSubject: "other-builder",
      reporterSubject: "other-builder",
    }),
    incident({
      domainId: "operations",
      projectId: "ops",
      id: "incident-operations",
      ownerSubject: "operations-builder",
      reporterSubject: "operations-builder",
    }),
  ];

  const adminResult = await harness({ incidents: records }).service
    .listIncidents({ identity: admin, limit: 20 });
  assert.equal(adminResult.items.length, 3);

  const leadResult = await harness({ incidents: records }).service
    .listIncidents({ identity: lead, limit: 20 });
  assert.deepEqual(
    leadResult.items.map(({ id }) => id).sort(),
    ["incident-001", "incident-foreign-owner"],
  );

  const builderResult = await harness({ incidents: records }).service
    .listIncidents({ identity: builder, limit: 20 });
  assert.deepEqual(
    builderResult.items.map(({ id }) => id),
    ["incident-001"],
  );
});

test("incident cursors advance across authorized domains without dropping records", async () => {
  const seen = [];
  const customerSupport = incident();
  const operationsIncident = incident({
    domainId: "operations",
    projectId: "ops",
    id: "incident-operations",
    ownerSubject: "operations-builder",
    reporterSubject: "operations-builder",
  });
  const { service } = harness({
    incidents: [customerSupport, operationsIncident],
    workspaceOverrides: {
      async listIncidents(input) {
        seen.push(structuredClone(input));
        return page(
          input.domainId === "customer_support"
            ? [customerSupport]
            : [operationsIncident],
        );
      },
    },
  });

  const first = await service.listIncidents({
    identity: admin,
    limit: 1,
  });
  assert.deepEqual(first.items.map(({ id }) => id), ["incident-001"]);
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/);

  const second = await service.listIncidents({
    identity: admin,
    limit: 1,
    cursor: first.cursor,
  });
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["incident-operations"],
  );
  assert.equal(second.cursor, null);
  assert.deepEqual(
    seen.map(({ domainId }) => domainId),
    ["customer_support", "operations"],
  );
});

test("Admin may report platform-wide, Lead in the selected domain, and Builder is read-only", async () => {
  const scenarios = [
    {
      identity: admin,
      domainId: "operations",
      project: project({
        domainId: "operations",
        id: "ops-agent",
        ownerSubject: "operations-builder",
      }),
    },
    {
      identity: lead,
      domainId: "customer_support",
      project: project(),
    },
  ];
  for (const scenario of scenarios) {
    const { calls, service } = harness({
      incidents: [],
      projects: [scenario.project],
    });
    const result = await service.createIncident({
      identity: scenario.identity,
      requestId: `create-${scenario.identity.role}-incident`,
      domainId: scenario.domainId,
      projectId: scenario.project.id,
      id: `${scenario.identity.role}-incident`,
      title: "Agent invocation failures",
      description: "Invocation failures exceeded the alert threshold.",
      severity: "CRITICAL",
      reason: "Opened after confirming the runtime health signal.",
    });

    assert.equal(result.incident.domainId, scenario.domainId);
    assert.equal(result.incident.reporterSubject, scenario.identity.actor);
    assert.equal(
      result.incident.ownerSubject,
      scenario.project.ownerSubject,
    );
    assert.equal(result.incident.status, "OPEN");
    const write = calls.find(([name]) => name === "putIncident")[1];
    assert.equal(write.mutation.actor, scenario.identity.actor);
    assert.equal(
      write.mutation.requesterSubject,
      scenario.identity.actor,
    );
    assert.equal(write.mutation.decision, "report");
    assert.equal(write.expectedStatus, null);
  }

  const { service } = harness({ incidents: [] });
  await assert.rejects(
    service.createIncident({
      identity: builder,
      requestId: "builder-project-incident",
      domainId: "customer_support",
      projectId: "case-assist",
      id: "builder-project-incident",
      title: "Builder project incident",
      description: "Builders remain read-only for owned incidents.",
      severity: "HIGH",
      reason: "Builder reporting must be denied.",
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.createIncident({
      identity: lead,
      requestId: "cross-domain-incident",
      domainId: "operations",
      projectId: "ops-agent",
      id: "cross-domain-incident",
      title: "Cross-domain incident",
      description: "A Lead cannot report outside the selected domain.",
      severity: "HIGH",
      reason: "Cross-domain reporting must be hidden.",
    }),
    expectCode("NOT_FOUND"),
  );
});

test("committed incident creation replays before a fresh transaction is created", async () => {
  let now = NOW;
  const { calls, service } = harness({
    incidents: [],
    now: () => now,
  });
  const input = {
    identity: lead,
    requestId: "create-incident-replay",
    domainId: "customer_support",
    projectId: "case-assist",
    id: "incident-replay",
    title: "Agent invocation failures",
    description: "Invocation failures exceeded the alert threshold.",
    severity: "CRITICAL",
    reason: "Opened after confirming the runtime health signal.",
  };

  const first = await service.createIncident(input);
  now += 10_000;
  const replay = await service.createIncident(input);

  assert.deepEqual(replay, first);
  assert.equal(
    calls.filter(([name]) => name === "putIncident").length,
    1,
  );
  assert.equal(
    calls.filter(([name]) => name === "beginTransaction").length,
    1,
  );
  await assert.rejects(
    service.createIncident({
      ...input,
      title: "A different mutation reusing the request ID",
    }),
    expectCode("CONFLICT"),
  );
});

test("a transaction conflict replays the committed server-clock result", async () => {
  const committedAt = NOW_ISO;
  let committedMutation = null;
  let committedRecord = null;
  const conflict = Object.assign(new Error("concurrent commit won"), {
    code: "MUTATION_CONFLICT",
  });
  const { service } = harness({
    incidents: [],
    now: NOW + 10_000,
    workspaceOverrides: {
      async putIncident(input) {
        committedMutation = {
          ...structuredClone(input.mutation),
          timestamp: committedAt,
          createdAt: committedAt,
        };
        committedRecord = {
          ...structuredClone(input.record),
          createdAt: committedAt,
          updatedAt: committedAt,
        };
        throw conflict;
      },
      async getMutationResult() {
        return committedMutation;
      },
      async getIncident() {
        return committedRecord;
      },
    },
  });

  const result = await service.createIncident({
    identity: lead,
    requestId: "create-incident-concurrent-replay",
    domainId: "customer_support",
    projectId: "case-assist",
    id: "incident-concurrent-replay",
    title: "Agent invocation failures",
    description: "Invocation failures exceeded the alert threshold.",
    severity: "CRITICAL",
    reason: "Opened after confirming the runtime health signal.",
  });

  assert.equal(result.incident.createdAt, committedAt);
  assert.equal(result.incident.updatedAt, committedAt);
});

test("incident actions enforce exact lifecycle and domain ownership", async () => {
  const adminHarness = harness({
    incidents: [incident({
      domainId: "operations",
      projectId: "ops-agent",
      id: "operations-incident",
      ownerSubject: "operations-builder",
      reporterSubject: "lead-operations-sub",
    })],
  });
  const adminAcknowledged = await adminHarness.service.actOnIncident({
    identity: admin,
    requestId: "admin-acknowledge-incident",
    incidentId: "operations-incident",
    action: "acknowledge",
    reason: "Platform response ownership accepted.",
  });
  assert.equal(adminAcknowledged.incident.domainId, "operations");
  assert.equal(adminAcknowledged.incident.status, "ACKNOWLEDGED");
  assert.equal(
    adminAcknowledged.incident.acknowledgedBySubject,
    "admin-sub",
  );

  const { service } = harness();
  const acknowledged = await service.actOnIncident({
    identity: lead,
    requestId: "acknowledge-incident",
    incidentId: "incident-001",
    action: "acknowledge",
    reason: "Response ownership accepted.",
  });
  assert.equal(acknowledged.incident.status, "ACKNOWLEDGED");
  assert.equal(acknowledged.incident.acknowledgedBySubject, "lead-sub");

  const resolved = await service.actOnIncident({
    identity: lead,
    requestId: "resolve-incident",
    incidentId: "incident-001",
    action: "resolve",
    reason: "Runtime error rate returned to normal.",
  });
  assert.equal(resolved.incident.status, "RESOLVED");

  const reopened = await service.actOnIncident({
    identity: lead,
    requestId: "reopen-incident",
    incidentId: "incident-001",
    action: "reopen",
    reason: "The elevated error rate returned.",
  });
  assert.equal(reopened.incident.status, "OPEN");
  assert.equal(reopened.incident.acknowledgedAt, null);
  assert.equal(reopened.incident.resolvedAt, null);
  assert.equal(reopened.incident.reopenedBySubject, "lead-sub");

  await assert.rejects(
    service.actOnIncident({
      identity: builder,
      requestId: "builder-acknowledge",
      incidentId: "incident-001",
      action: "acknowledge",
      reason: "Builder cannot manage incident state.",
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.actOnIncident({
      identity: lead,
      requestId: "invalid-resolve",
      incidentId: "incident-001",
      action: "resolve",
      reason: "Cannot resolve an open incident.",
    }),
    expectCode("CONFLICT"),
  );
});

test("committed incident actions replay before lifecycle validation", async () => {
  let now = NOW;
  const { calls, service } = harness({ now: () => now });
  const input = {
    identity: lead,
    requestId: "acknowledge-incident-replay",
    incidentId: "incident-001",
    action: "acknowledge",
    reason: "Response ownership accepted.",
  };

  const first = await service.actOnIncident(input);
  now += 10_000;
  const replay = await service.actOnIncident(input);

  assert.deepEqual(replay, first);
  assert.equal(
    calls.filter(([name]) => name === "putIncident").length,
    1,
  );
  await assert.rejects(
    service.actOnIncident({
      ...input,
      reason: "A different action payload reusing the request ID.",
    }),
    expectCode("CONFLICT"),
  );
});

test("committed incident action replay reauthorizes the current caller", async () => {
  let authorized = true;
  const { calls, service } = harness({
    authorize: async () => {
      if (!authorized) {
        throw Object.assign(new Error("access revoked"), {
          code: "FORBIDDEN",
        });
      }
      return { ok: true };
    },
  });
  const input = {
    identity: lead,
    requestId: "acknowledge-incident-reauthorize",
    incidentId: "incident-001",
    action: "acknowledge",
    reason: "Response ownership accepted.",
  };

  await service.actOnIncident(input);
  authorized = false;

  await assert.rejects(
    service.actOnIncident(input),
    expectCode("FORBIDDEN"),
  );
  assert.equal(
    calls.filter(([name]) => name === "authorize").length,
    2,
  );
  assert.equal(
    calls.filter(([name]) => name === "putIncident").length,
    1,
  );
});

test("committed incident action replay returns the original action snapshot", async () => {
  const { incidentRecords, service } = harness();
  const input = {
    identity: lead,
    requestId: "acknowledge-incident-immutable-replay",
    incidentId: "incident-001",
    action: "acknowledge",
    reason: "Response ownership accepted.",
  };

  const first = await service.actOnIncident(input);
  incidentRecords.set(
    "customer_support/incident-001",
    incident({
      status: "RESOLVED",
      acknowledgedBySubject: "lead-sub",
      acknowledgedAt: NOW_ISO,
      resolvedBySubject: "lead-sub",
      resolvedAt: "2026-08-25T02:05:00.000Z",
      lastActionReason: "Runtime error rate returned to normal.",
      updatedAt: "2026-08-25T02:05:00.000Z",
    }),
  );

  const replay = await service.actOnIncident(input);

  assert.deepEqual(replay, first);
  assert.equal(replay.incident.status, "ACKNOWLEDGED");
  assert.equal(replay.incident.resolvedBySubject, null);
  assert.equal(replay.incident.resolvedAt, null);
});

test("committed incident action replay fails closed on evidence mismatch", async () => {
  const { calls, incidentRecords, service } = harness();
  const input = {
    identity: lead,
    requestId: "acknowledge-incident-evidence-mismatch",
    incidentId: "incident-001",
    action: "acknowledge",
    reason: "Response ownership accepted.",
  };

  await service.actOnIncident(input);
  incidentRecords.set(
    "customer_support/incident-001",
    incident({
      status: "ACKNOWLEDGED",
      acknowledgedBySubject: "another-lead-sub",
      acknowledgedAt: "2026-08-25T02:05:00.000Z",
      lastActionReason: "A later acknowledgement replaced the evidence.",
      updatedAt: "2026-08-25T02:05:00.000Z",
    }),
  );

  await assert.rejects(
    service.actOnIncident(input),
    expectCode("CONFLICT"),
  );
  assert.equal(
    calls.filter(([name]) => name === "authorize").length,
    2,
  );
});

test("break-glass requires Admin, peer approval, requester activation, and an unexpired server clock", async () => {
  const { calls, service } = harness({ breakGlassRecords: [] });
  const requested = await service.requestBreakGlass({
    identity: admin,
    requestId: "request-break-glass",
    id: "break-glass-002",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "trace/customer_support/case-assist/trace-002",
    action: "trace:read-content",
    reason: "Investigate a critical production incident.",
    durationMinutes: 30,
  });
  assert.equal(requested.breakGlass.status, "REQUESTED");
  assert.equal(
    requested.breakGlass.expiresAt,
    "2026-08-25T02:30:00.000Z",
  );
  assert.equal(requested.breakGlass.requesterSubject, "admin-sub");

  await assert.rejects(
    service.decideBreakGlass({
      identity: admin,
      requestId: "self-approve-break-glass",
      id: "break-glass-002",
      decision: "approve",
      reason: "Self approval must be denied.",
    }),
    expectCode("REQUESTER_CANNOT_APPROVE"),
  );

  const peer = { ...admin, actor: "peer-admin-sub" };
  const approved = await service.decideBreakGlass({
    identity: peer,
    requestId: "approve-break-glass",
    id: "break-glass-002",
    decision: "approve",
    reason: "Peer review confirmed the exact resource and action.",
  });
  assert.equal(approved.breakGlass.status, "APPROVED");
  assert.equal(approved.breakGlass.approverSubject, "peer-admin-sub");

  await assert.rejects(
    service.activateBreakGlass({
      identity: peer,
      requestId: "foreign-activate-break-glass",
      id: "break-glass-002",
      reason: "Only the requester may activate.",
    }),
    expectCode("FORBIDDEN"),
  );

  const activated = await service.activateBreakGlass({
    identity: admin,
    requestId: "activate-break-glass",
    id: "break-glass-002",
    reason: "Begin the approved incident investigation.",
  });
  assert.equal(activated.breakGlass.status, "ACTIVE");
  assert.equal(activated.breakGlass.resource, requested.breakGlass.resource);
  assert.equal(activated.breakGlass.action, requested.breakGlass.action);
  assert.ok(calls.some(
    ([name, input]) =>
      name === "putBreakGlass"
      && input.mutation.decision === "activate",
  ));
});

test("committed break-glass mutations replay after the server clock passes expiry", async () => {
  const peer = { ...admin, actor: "peer-admin-sub" };
  const scenarios = [
    {
      records: [],
      invoke(service) {
        return service.requestBreakGlass({
          identity: admin,
          requestId: "request-break-glass-replay",
          id: "break-glass-replay",
          domainId: "customer_support",
          projectId: "case-assist",
          resource: "trace/customer_support/case-assist/trace-replay",
          action: "trace:read-content",
          reason: "Investigate a critical production incident.",
          durationMinutes: 30,
        });
      },
      expectedStatus: "REQUESTED",
    },
    {
      records: [breakGlass({
        id: "break-glass-replay",
        requesterSubject: "requester-admin-sub",
      })],
      invoke(service) {
        return service.decideBreakGlass({
          identity: peer,
          requestId: "approve-break-glass-replay",
          id: "break-glass-replay",
          decision: "approve",
          reason: "Peer review confirmed the exact resource and action.",
        });
      },
      expectedStatus: "APPROVED",
    },
    {
      records: [breakGlass({
        id: "break-glass-replay",
        status: "APPROVED",
        approverSubject: "peer-admin-sub",
        decisionReason: "Peer review confirmed the exact resource and action.",
        decidedAt: NOW_ISO,
      })],
      invoke(service) {
        return service.activateBreakGlass({
          identity: admin,
          requestId: "activate-break-glass-replay",
          id: "break-glass-replay",
          reason: "Begin the approved incident investigation.",
        });
      },
      expectedStatus: "ACTIVE",
    },
    {
      records: [breakGlass({
        id: "break-glass-replay",
        status: "ACTIVE",
        approverSubject: "peer-admin-sub",
        decisionReason: "Peer review confirmed the exact resource and action.",
        decidedAt: NOW_ISO,
        activatedBySubject: "admin-sub",
        activationReason: "Begin the approved incident investigation.",
        activatedAt: NOW_ISO,
      })],
      invoke(service) {
        return service.revokeBreakGlass({
          identity: peer,
          requestId: "revoke-break-glass-replay",
          id: "break-glass-replay",
          reason: "Investigation completed before expiry.",
        });
      },
      expectedStatus: "REVOKED",
    },
  ];

  for (const scenario of scenarios) {
    let now = NOW;
    const { calls, service } = harness({
      breakGlassRecords: scenario.records,
      now: () => now,
    });
    const first = await scenario.invoke(service);
    assert.equal(first.breakGlass.status, scenario.expectedStatus);
    now = Date.parse("2026-08-25T03:00:00.000Z");
    const replay = await scenario.invoke(service);
    assert.deepEqual(replay, first);
    assert.equal(
      calls.filter(([name]) => name === "putBreakGlass").length,
      1,
    );
  }
});

test("break-glass list marks server-expired grants and revocation ends active access", async () => {
  const expired = breakGlass({
    status: "ACTIVE",
    requestedAt: "2026-08-25T01:00:00.000Z",
    expiresAt: "2026-08-25T01:59:00.000Z",
    approverSubject: "peer-admin-sub",
    decisionReason: "Peer approved.",
    decidedAt: "2026-08-25T01:30:00.000Z",
    activatedBySubject: "admin-sub",
    activationReason: "Activated.",
    activatedAt: "2026-08-25T01:31:00.000Z",
  });
  const active = breakGlass({
    id: "break-glass-active",
    status: "ACTIVE",
    approverSubject: "peer-admin-sub",
    decisionReason: "Peer approved.",
    decidedAt: NOW_ISO,
    activatedBySubject: "admin-sub",
    activationReason: "Activated.",
    activatedAt: NOW_ISO,
  });
  const { service } = harness({
    breakGlassRecords: [expired, active],
  });

  const listed = await service.listBreakGlass({
    identity: admin,
    limit: 20,
  });
  assert.deepEqual(
    listed.items.map(({ id, effectiveStatus }) => ({
      id,
      effectiveStatus,
    })),
    [
      { id: "break-glass-active", effectiveStatus: "ACTIVE" },
      { id: "break-glass-001", effectiveStatus: "EXPIRED" },
    ],
  );

  const revoked = await service.revokeBreakGlass({
    identity: { ...admin, actor: "peer-admin-sub" },
    requestId: "revoke-break-glass",
    id: "break-glass-active",
    reason: "Investigation completed before expiry.",
  });
  assert.equal(revoked.breakGlass.status, "REVOKED");
  assert.equal(revoked.breakGlass.revokedBySubject, "peer-admin-sub");

  await assert.rejects(
    service.revokeBreakGlass({
      identity: admin,
      requestId: "revoke-expired-break-glass",
      id: "break-glass-001",
      reason: "Expired access is already inactive.",
    }),
    expectCode("CONFLICT"),
  );
});

test("break-glass cursors resume the exact state page and reject wrong limits", async () => {
  const firstCursor = {
    pk: "BREAK_GLASS",
    sk: "BREAK_GLASS#break-glass-001",
  };
  const seen = [];
  const firstRecord = breakGlass();
  const secondRecord = breakGlass({ id: "break-glass-002" });
  const { service } = harness({
    workspaceOverrides: {
      async listBreakGlass(input) {
        seen.push(structuredClone(input));
        return seen.length === 1
          ? page([firstRecord], firstCursor)
          : page([secondRecord]);
      },
    },
  });

  const first = await service.listBreakGlass({
    identity: admin,
    limit: 1,
  });
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/);
  const second = await service.listBreakGlass({
    identity: admin,
    limit: 1,
    cursor: first.cursor,
  });
  assert.deepEqual(second.items.map(({ id }) => id), ["break-glass-002"]);
  assert.deepEqual(seen[1].cursor, firstCursor);
  assert.equal(second.cursor, null);

  await assert.rejects(
    service.listBreakGlass({
      identity: admin,
      limit: 2,
      cursor: first.cursor,
    }),
    expectCode("NOT_FOUND"),
  );
});
