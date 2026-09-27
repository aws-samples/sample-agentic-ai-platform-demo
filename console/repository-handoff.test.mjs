import test from "node:test";
import assert from "node:assert/strict";
import { repositoryHandoff, agentRepositoryName } from "./public/repository-handoff.mjs";

test("delivered repository provides exact clone and Actions destinations", () => {
  assert.deepEqual(repositoryHandoff("https://github.com/example/service-agent"), {
    url: "https://github.com/example/service-agent",
    actionsUrl: "https://github.com/example/service-agent/actions",
    commands: "git clone -- https://github.com/example/service-agent.git\ncd -- service-agent",
  });
});

test("untrusted URLs never become shell commands or GitHub links", () => {
  for (const url of [null, "javascript:alert(1)", "https://github.com/example/x;id",
    "https://github.com/example/$(id)", "https://github.com/example/..",
    "https://github.com/example/-x", "https://github.com.evil.test/example/repo",
    "https://github.com/example/repo?token=x", "https://github.com/example/repo\nid"]) {
    assert.equal(repositoryHandoff(url), null);
  }
});

 test("repository defaults to Agent build name, never the owning project",()=>{
 assert.equal(agentRepositoryName({name:"Contract Review Assistant",id:"agent-123",projectId:"platform-foundation"}),"contract-review-assistant");
 assert.equal(agentRepositoryName({name:"Retail Insights Live"}),"retail-insights-live");
 assert.equal(agentRepositoryName({id:"support-agent",projectId:"platform-foundation"}),"support-agent");
});
