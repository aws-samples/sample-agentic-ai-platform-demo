import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateEvaluation} from './public/evaluation-config.mjs';
import {evaluationAssets} from './evaluation-assets.mjs';
import {assets} from './evaluation-assets-data.mjs';
test('packaged Lambda evaluation assets match their editable source',()=>{
 for(const [name,content] of Object.entries(assets))assert.equal(content,readFileSync(new URL('./evaluation-assets/'+name,import.meta.url),'utf8'));
});
test('private datasets export only references and custom evaluator source is not executed',()=>{
 const code='raise RuntimeError("must not execute during export")';
 const files=evaluationAssets({dataset:{source:'reference',reference:'s3://private-bucket/cases.jsonl'},evaluator:{type:'python',code}});
 assert.ok(!files.some(f=>f.path==='evaluation/dataset.jsonl'));
 assert.equal(files.find(f=>f.path==='evaluation/evaluator.py').content,code);
 assert.match(files.find(f=>f.path==='evaluation/config.json').content,/NOT_RUN/);
});
test('malformed datasets, duplicate cases, credentials in references and unsupported modes are rejected',()=>{
 for(const dataset of [{source:'upload',content:'{}'},{source:'upload',content:'{"id":"a","input":"x"}\n{"id":"a","input":"y"}'},{source:'reference',reference:'https://private/path?token=secret'},{source:'invalid'}])assert.throws(()=>validateEvaluation({dataset,evaluator:{type:'later'}}));
 assert.throws(()=>validateEvaluation({dataset:{source:'later'},evaluator:{type:'python',code:''}}));
});
test('deferred configuration exports real runner and instructions with no fabricated results',()=>{
 const files=evaluationAssets();
 assert.ok(files.some(f=>f.path==='.github/workflows/eval.yml'));
 assert.ok(files.some(f=>f.path==='evaluation/test_evaluation.py'));
 assert.ok(!files.some(f=>/report.json$/.test(f.path)));
});

test('exported pytest runner fails closed and evaluates custom business code with the inherited threshold',()=>{
 const root=mkdtempSync(join(tmpdir(),'evaluation-package-'));
 try{
  const config={dataset:{source:'upload',content:'{"id":"fixture","input":"synthetic","expected":"answer"}\n'},evaluator:{type:'builtin'}};
  for(const file of evaluationAssets(config)){const p=join(root,file.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,file.content);}
  writeFileSync(join(root,'gates/platform-gates.json'),JSON.stringify({threshold:0.9}));
  const run=()=>spawnSync('python3',['-m','pytest','evaluation/test_evaluation.py','-q'],{cwd:root,encoding:'utf8',env:{...process.env,PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1'},timeout:30000});
  assert.notEqual(run().status,0,'unimplemented Agent adapter must not pass');
  writeFileSync(join(root,'evaluation/agent_adapter.py'),'def run(case):\n    return {"output":"synthetic answer"}\n');
  let result=run();assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root,'evaluation/report.json'))).status,'PASSED');
  writeFileSync(join(root,'evaluation/evaluator.py'),'def evaluate(case, result):\n    return {"score":0.5,"reason":"below floor"}\n');
  assert.notEqual(run().status,0,'custom score below inherited floor must fail');
  writeFileSync(join(root,'evaluation/evaluator.py'),'def evaluate(case, result):\n    return {"score":float("nan"),"reason":"invalid"}\n');
  assert.notEqual(run().status,0,'invalid score must fail');
  writeFileSync(join(root,'evaluation/config.json'),JSON.stringify({dataset:{source:'later'},evaluator:{type:'later'}}));
  assert.notEqual(run().status,0);
  assert.equal(JSON.parse(readFileSync(join(root,'evaluation/report.json'))).status,'NOT_CONFIGURED');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('blueprint-supplied dataset is used ahead of the platform starter fallback',()=>{
 const content='{"id":"blueprint-case","input":"Template-specific input","expected":"template result"}\n';
 const files=evaluationAssets({dataset:{source:'blueprint'},evaluator:{type:'builtin'}},{starterDataset:content});
 assert.equal(files.find(f=>f.path==='evaluation/dataset.jsonl').content,content);
});
