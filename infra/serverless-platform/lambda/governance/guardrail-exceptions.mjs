import { createHash } from "node:crypto";
import { GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { GUARDRAIL_CATALOG } from "../../../../console/public/guardrail-chain.mjs";

const text = (v, min, max) => typeof v === "string" && v === v.trim()
  && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const slug = v => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v);
const domain = v => typeof v === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(v);
const digest = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const key = (domainId, id) => ({ pk: { S: `GUARDRAIL_EXCEPTION#${domainId}` }, sk: { S: id } });

// Retained review records. Approval is permission to propose a scoped change;
// it never edits an agent, overrides mandatory controls, or claims deployment.
export function createGuardrailExceptionStore({ dynamo, tableName }) {
  const decode = item => {
    if (!item) return null;
    const row = JSON.parse(item.document.S);
    if (!domain(row.domainId) || !slug(row.id) || !Number.isSafeInteger(row.revision)
      || item.pk?.S !== key(row.domainId, row.id).pk.S || item.sk?.S !== row.id
      || item.revision?.N !== String(row.revision) || !Array.isArray(row.history)) {
      throw new Error("Invalid exception record");
    }
    return row;
  };
  return {
    async get(domainId, id) {
      return decode((await dynamo.send(new GetItemCommand({
        TableName: tableName, Key: key(domainId, id), ConsistentRead: true,
      }))).Item);
    },
    async list(domainId) {
      const rows = [];
      let cursor;
      const seen = new Set();
      do {
        const r = await dynamo.send(new QueryCommand({
          TableName: tableName, KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": { S: `GUARDRAIL_EXCEPTION#${domainId}` } },
          ConsistentRead: true, Limit: 100,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }));
        if (!Array.isArray(r.Items)) throw new Error("Invalid exception inventory");
        rows.push(...r.Items.map(decode));
        cursor = r.LastEvaluatedKey;
        if (cursor) {
          const encoded = JSON.stringify(cursor);
          if (seen.has(encoded) || rows.length >= 1000) throw new Error("Exception inventory limit reached");
          seen.add(encoded);
        }
      } while (cursor);
      return rows;
    },
    async put(row, expectedRevision) {
      await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: { ...key(row.domainId, row.id), revision: { N: String(row.revision) }, document: { S: JSON.stringify(row) } },
        ConditionExpression: expectedRevision === null ? "attribute_not_exists(pk)" : "#revision = :revision",
        ...(expectedRevision === null ? {} : {
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":revision": { N: String(expectedRevision) } },
        }),
      }));
    },
  };
}

export function createGuardrailOperations({ store, workspaceState, domainDirectory, validateIdentity, fail, now = () => new Date() }) {
  const requireStore = () => { if (!store) fail("WORKSPACE_UNAVAILABLE"); };
  async function projectAccess(identity, domainId, projectId) {
    if (!domain(domainId) || !slug(projectId)) fail("INVALID_REQUEST");
    if (!identity.domainIds.includes(domainId)) fail("FORBIDDEN");
    if (identity.role !== "admin" && identity.activeDomain !== domainId) fail("FORBIDDEN");
    const project = await workspaceState.getProject({ domainId, projectId });
    if (!project || project.domainId !== domainId || project.id !== projectId) fail("NOT_FOUND");
    if (identity.role === "builder" && project.ownerSubject !== identity.actor
      && !project.memberSubjects?.includes(identity.actor)) fail("FORBIDDEN");
    if (!["admin", "lead", "builder"].includes(identity.role)) fail("FORBIDDEN");
    return project;
  }
  const visible = row => ["approved", "pending_domain", "pending_platform"].includes(row.status) && Date.parse(row.expiresAt) <= now().getTime()
    ? { ...row, status: "expired" } : row;
  async function save(row, revision) {
    try { await store.put(row, revision); }
    catch (error) {
      if (error?.name === "ConditionalCheckFailedException") fail("CONFLICT");
      fail("WORKSPACE_UNAVAILABLE");
    }
    return { exception: visible(row) };
  }
  return {
    async readGuardrails({ identity }) {
      const actor = validateIdentity(identity);
      if (!["admin", "lead", "builder"].includes(actor.role)) fail("FORBIDDEN");
      return { source: "foundation-harness", revision: 1, scope: "platform",
        controls: GUARDRAIL_CATALOG.map(c => ({ ...c,
          enforcement: "BUILD_CONFIGURATION", runtimeStatus: "NOT_VERIFIED",
          exceptionAllowed: !c.mandatory,
        })) };
    },
    async listGuardrailExceptions({ identity, limit = 50, cursor }) {
      requireStore();
      const actor = validateIdentity(identity);
      if (!["admin", "lead", "builder"].includes(actor.role)) fail("FORBIDDEN");
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("INVALID_REQUEST");
      const domains = actor.activeDomain ? [actor.activeDomain] : actor.domainIds;
      let offset = 0;
      const scope = digest([actor.actor, actor.role, domains]);
      if (cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
          if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) fail("INVALID_REQUEST");
          offset = parsed.offset;
        } catch { fail("INVALID_REQUEST"); }
      }
      const rows = [];
      for (const domainId of domains) {
        if (!(await domainDirectory.getDomain(domainId))) continue;
        const records = await store.list(domainId);
        for (const row of records) {
          if (actor.role === "builder") {
            const p = await workspaceState.getProject({ domainId, projectId: row.projectId });
            if (!p || (p.ownerSubject !== actor.actor && !p.memberSubjects?.includes(actor.actor))) continue;
          }
          rows.push(visible(row));
        }
      }
      rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id));
      return { source: "workspace-guardrail-exceptions", exemptions: rows.slice(offset, offset + limit),
        cursor: offset + limit < rows.length ? Buffer.from(JSON.stringify({ scope, offset: offset + limit })).toString("base64url") : null };
    },
    async requestGuardrailException(input) {
      requireStore();
      const actor = validateIdentity(input.identity);
      await projectAccess(actor, input.domainId, input.projectId);
      const control = GUARDRAIL_CATALOG.find(c => c.id === input.guardrailId);
      if (!control || !text(input.reason, 10, 2000) || !text(input.compensatingControls, 10, 2000)
        || !text(input.requestId, 1, 128) || !Number.isFinite(Date.parse(input.expiresAt))) fail("INVALID_REQUEST");
      if (control.mandatory) fail("FORBIDDEN");
      const payload = { domainId: input.domainId, projectId: input.projectId, guardrailId: input.guardrailId,
        reason: input.reason, compensatingControls: input.compensatingControls, expiresAt: input.expiresAt };
      const id = `exception-${digest([actor.actor, input.requestId]).slice(0, 24)}`;
      const existing = await store.get(input.domainId, id);
      if (existing) {
        if (existing.requesterSubject !== actor.actor || existing.fingerprint !== digest(payload)) fail("CONFLICT");
        return { exception: visible(existing), replayed: true };
      }
      const timestamp = now().toISOString(), expires = Date.parse(input.expiresAt);
      if (expires <= Date.parse(timestamp) || expires > Date.parse(timestamp) + 30 * 86400000) fail("INVALID_REQUEST");
      const status = input.domainId === "platform" ? "pending_platform" : "pending_domain";
      return save({ id, ...payload, fingerprint: digest(payload), revision: 1, requesterSubject: actor.actor,
        requestedAt: timestamp, status, domainApproverSubject: null, platformApproverSubject: null,
        history: [{ action: "requested", actor: actor.actor, reason: input.reason, timestamp, requestId: input.requestId }] }, null);
    },
    async decideGuardrailException(input) {
      requireStore();
      const actor = validateIdentity(input.identity);
      if (!domain(input.domainId) || !slug(input.id) || !["approve", "reject", "revoke"].includes(input.decision)
        || !text(input.reason, 10, 2000) || !text(input.requestId, 1, 128)) fail("INVALID_REQUEST");
      const row = await store.get(input.domainId, input.id);
      if (!row) fail("NOT_FOUND");
      await projectAccess(actor, row.domainId, row.projectId);
      if (!["admin", "lead"].includes(actor.role) || row.requesterSubject === actor.actor) fail("FORBIDDEN");
      const replay = row.history.find(h => h.requestId === input.requestId && h.actor === actor.actor);
      if (replay) {
        if (replay.action !== input.decision || replay.reason !== input.reason) fail("CONFLICT");
        return { exception: visible(row), replayed: true };
      }
      if (Date.parse(row.expiresAt) <= now().getTime()) fail("CONFLICT");
      if (input.decision === "revoke") {
        if (actor.role !== "admin" || row.status !== "approved") fail("FORBIDDEN");
      } else {
        if (!["pending_domain", "pending_platform"].includes(row.status)) fail("CONFLICT");
        if (row.status === "pending_platform" && (actor.role !== "admin" || actor.actor === row.domainApproverSubject)) fail("FORBIDDEN");
      }
      const timestamp = now().toISOString();
      const next = { ...row, revision: row.revision + 1,
        status: input.decision === "revoke" ? "revoked" : input.decision === "reject" ? "rejected"
          : row.status === "pending_domain" ? "pending_platform" : "approved",
        ...(input.decision === "approve" ? row.status === "pending_domain"
          ? { domainApproverSubject: actor.actor } : { platformApproverSubject: actor.actor } : {}),
        history: [...row.history, { action: input.decision, actor: actor.actor, reason: input.reason, timestamp, requestId: input.requestId }] };
      return save(next, row.revision);
    },
  };
}
