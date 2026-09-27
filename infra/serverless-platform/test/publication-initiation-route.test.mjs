import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('publication initiation is declared in the existing JWT governance route group',()=>{
 const source=readFileSync(new URL('../lib/platform-web-stack.ts',import.meta.url),'utf8');
 const start=source.indexOf('"GovernanceAgentPublicationRoute"');
 const end=source.indexOf('route.addResourceDependency(governanceIntegration)',start);
 assert.ok(start>=0 && end>start);
 const group=source.slice(start,end);
 assert.match(group,/"GovernancePublicationInitiationRoute",\s*"POST \/api\/governance\/publication-initiations"/);
 assert.match(group,/authorizationType: "JWT"/);
 assert.match(group,/authorizerId: authorizer.ref/);
 assert.match(group,/target: `integrations\/\$\{governanceIntegration.ref\}`/);
 assert.match(source,/"AllowGovernancePublicationInitiationInvoke",\s*"POST",\s*"governance\/publication-initiations"/);
});
