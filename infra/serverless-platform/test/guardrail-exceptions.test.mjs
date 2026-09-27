import test from "node:test";
import assert from "node:assert/strict";
import { createGuardrailOperations, createGuardrailExceptionStore } from "../lambda/governance/guardrail-exceptions.mjs";
const now = () => new Date("2026-09-17T00:00:00.000Z");
const actor = (id, role = "admin") => ({ actor: id, role, activeDomain: role === "admin" ? null : "operations", domainIds: ["platform", "operations"] });
function fixture() {
  const records = new Map();
  const project = { id: "case-assist", domainId: "operations", ownerSubject: "builder-one", memberSubjects: [] };
  const store = {
    async get(d, id) { return records.get(`${d}/${id}`) ?? null; },
    async list(d) { return [...records.values()].filter(r=>r.domainId===d); },
    async put(row, expected) {
      const key=`${row.domainId}/${row.id}`, prior=records.get(key);
      if ((prior?.revision ?? null) !== expected) throw Object.assign(new Error(), {name:"ConditionalCheckFailedException"});
      records.set(key, structuredClone(row));
    },
  };
  const service=createGuardrailOperations({
    store, now, workspaceState:{ async getProject({domainId,projectId}) { return domainId===project.domainId&&projectId===project.id?project:null; } },
    domainDirectory:{async getDomain(id){return {id};}},
    validateIdentity:v=>v, fail:code=>{throw Object.assign(new Error(code),{code});},
  });
  const input={identity:actor("builder-one","builder"),requestId:"request-one",domainId:"operations",projectId:"case-assist",
    guardrailId:"topic-restriction",reason:"Evaluate a new customer support topic.",compensatingControls:"Limit the test to a reviewed golden dataset.",
    expiresAt:"2026-09-24T00:00:00.000Z"};
  return {service,input,records,store};
}
test("guardrail catalog is seeded from controls, never blueprint declarations",async()=>{
  const {service}=fixture();const catalog=await service.readGuardrails({identity:actor("admin")});
  assert.equal(catalog.controls.length,5);
  assert.equal(catalog.controls.filter(c=>c.mandatory).length,4);
  assert.ok(catalog.controls.every(c=>c.runtimeStatus==="NOT_VERIFIED"));
});
test("exception requires two independent reviewers, retains reasons and never changes a runtime",async()=>{
  const {service,input}=fixture();
  const {exception}=await service.requestGuardrailException(input);
  const decide={domainId:exception.domainId,id:exception.id,reason:"Scope and compensating controls reviewed.",decision:"approve"};
  await assert.rejects(service.decideGuardrailException({...decide,identity:input.identity,requestId:"self"}),{code:"FORBIDDEN"});
  const domain=await service.decideGuardrailException({...decide,identity:actor("lead-one","lead"),requestId:"domain"});
  assert.equal(domain.exception.status,"pending_platform");
  await assert.rejects(service.decideGuardrailException({...decide,identity:actor("lead-one"),requestId:"same-reviewer"}),{code:"FORBIDDEN"});
  const platform=await service.decideGuardrailException({...decide,identity:actor("platform-one"),requestId:"platform"});
  assert.equal(platform.exception.status,"approved");
  assert.equal(platform.exception.history.length,3);
  assert.equal(platform.exception.domainApproverSubject,"lead-one");
  assert.equal(platform.exception.platformApproverSubject,"platform-one");
  const replay=await service.decideGuardrailException({...decide,identity:actor("platform-one"),requestId:"platform"});
  assert.equal(replay.replayed,true);
  assert.equal(replay.exception.history.length,3);
  const revoked=await service.decideGuardrailException({...decide,decision:"revoke",identity:actor("platform-one"),requestId:"revoke"});
  assert.equal(revoked.exception.status,"revoked");
});
test("mandatory controls, unassigned builders and cross-domain requests are rejected",async()=>{
  const {service,input}=fixture();
  await assert.rejects(service.requestGuardrailException({...input,guardrailId:"pii-detection"}),{code:"FORBIDDEN"});
  await assert.rejects(service.requestGuardrailException({...input,identity:actor("outsider","builder")}),{code:"FORBIDDEN"});
  await assert.rejects(service.requestGuardrailException({...input,identity:{...input.identity,activeDomain:"platform"}}),{code:"FORBIDDEN"});
});
test("request replay is immutable and expiry is limited to 30 days",async()=>{
  const {service,input,records}=fixture();
  await service.requestGuardrailException(input);
  assert.equal((await service.requestGuardrailException(input)).replayed,true);
  assert.equal(records.size,1);
  await assert.rejects(service.requestGuardrailException({...input,reason:"Different justification after submission."}),{code:"CONFLICT"});
  await assert.rejects(service.requestGuardrailException({...input,requestId:"later",expiresAt:"2027-01-01T00:00:00Z"}),{code:"INVALID_REQUEST"});
});
test("builder list cannot reveal another project's requests",async()=>{
  const {service,input}=fixture();await service.requestGuardrailException(input);
  assert.equal((await service.listGuardrailExceptions({identity:input.identity})).exemptions.length,1);
  assert.equal((await service.listGuardrailExceptions({identity:actor("outsider","builder")})).exemptions.length,0);
});
test("exception store uses retained conditional writes and a dedicated partition",async()=>{
  const commands=[];const store=createGuardrailExceptionStore({tableName:"platform-state",dynamo:{async send(c){commands.push(c);return {};}}});
  const row={id:"exception-one",domainId:"operations",revision:1,history:[]};
  await store.put(row,null);
  assert.equal(commands[0].input.Item.pk.S,"GUARDRAIL_EXCEPTION#operations");
  assert.equal(commands[0].input.ConditionExpression,"attribute_not_exists(pk)");
  assert.equal(commands[0].input.Item.expiresAt,undefined);
  await store.put({...row,revision:2},1);
  assert.equal(commands[1].input.ConditionExpression,"#revision = :revision");
});
