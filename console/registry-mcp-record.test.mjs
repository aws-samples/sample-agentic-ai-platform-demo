import test from 'node:test';
import assert from 'node:assert/strict';
import {recordToVersion,recordsToEntries} from './registry-shape.mjs';
const record=(data={name:'example/weather',description:'Weather tools',version:'1.0.0'})=>({registryId:'testregistry',recordId:'testrecord',recordArn:'arn:aws:agent-registry:us-west-2:111122223333:registry/testregistry/record/testrecord',name:'weather-record',recordType:'MCP',recordVersion:'1.0.0',status:'APPROVED',descriptors:{mcpServer:{data:JSON.stringify(data),dataSchemaVersion:'2025-12-11'}}});
test('official minimal MCP server descriptor maps to Registry MCPServer without Gateway identity',()=>{
 const mapped=recordToVersion(record());assert.ok(mapped);assert.equal(mapped.entry.type,'MCPServer');assert.equal(mapped.entry.id,'weather-record');assert.equal(mapped.version.status,'APPROVED');assert.equal(mapped.version.content.gateway,null);assert.equal(mapped.version.content.endpoint,null);
 assert.equal(recordsToEntries([record()],()=> 'shared')[0].type,'MCPServer');
});
test('cross-registry application aliases are qualified without losing record identity',()=>{
 const first=record(),second={...record(),registryId:'otherregistry',recordId:'otherrecord',recordArn:'arn:aws:agent-registry:us-west-2:111122223333:registry/otherregistry/record/otherrecord'};
 const entries=recordsToEntries([first,second]);
 assert.equal(entries.length,2);
 assert.deepEqual(entries.map(x=>x.id).sort(),['otherregistry/weather-record','testregistry/weather-record']);
 assert.equal(entries[0].versions[0]._aws.recordId,'testrecord');
 assert.ok(!entries.some(x=>x.id==='weather-record'),'ambiguous unqualified alias is not selectable');
 assert.throws(()=>recordsToEntries([first,first]),/identity is duplicated/);
 const alias=data=>record({...data,'x-platform':{id:'shared-alias'}});
 const sameRegistry=[alias({name:'example/one',description:'one',version:'1.0.0'}),{...alias({name:'example/two',description:'two',version:'1.0.0'}),name:'second-record',recordId:'secondrecord'}];
 assert.deepEqual(recordsToEntries(sameRegistry).map(x=>x.id).sort(),['testregistry/second-record','testregistry/weather-record']);
});
test('MCP remote descriptor preserves endpoint and rejects malformed descriptor',()=>{
 const value=record({name:'example/weather',description:'Weather tools',version:'1.0.0',remotes:[{type:'streamable-http',url:'https://example.com/mcp'}]});
 assert.equal(recordToVersion(value).version.content.endpoint,'https://example.com/mcp');
 for(const data of [[],{}, {name:'example/weather',description:'x',version:'1.0.0',remotes:'invalid'}]) assert.throws(()=>recordToVersion(record(data)));
});
