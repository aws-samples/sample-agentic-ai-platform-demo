import { assets } from './evaluation-assets-data.mjs';
import { validateEvaluation } from './public/evaluation-config.mjs';
export function evaluationAssets(input, {starterDataset}={}){
 const config=validateEvaluation(input);
 const {dataset,evaluator}=config;
 const files={
  'AGENTS.md':'# Development handoff\n\nRead CLAUDE.md and domain-harness.json for the generated construct and inherited controls. This Agent has not been deployed or evaluated. Implement your Domain Harness locally; never weaken Foundation controls.\n\nRead evaluation/README.md. Configure your dataset and evaluator, connect the real Agent adapter, and run the tests before proposing a release. Production requires the separate human approval tied to the exact release.\n',
  'gates/README.md':'# CI checks\n\nBusiness evaluation: see evaluation/README.md. Install evaluation/requirements.txt and run node gates/run-eval.mjs. Unconfigured evaluation fails; exporting a construct does not require it to pass.\n\nFoundation checks: node gates/check-guardrails.mjs and node gates/run-tests.mjs remain required. The threshold in gates/platform-gates.json is inherited. Never remove controls to pass CI. Production requires the release-bound human approval.\n',
  'gates/run-eval.mjs':"// platform-gate: v1 — business evaluation dispatcher\nimport {spawnSync} from 'node:child_process';\nimport {existsSync} from 'node:fs';\nconst python=['.venv/bin/python','.venv/Scripts/python.exe'].find(existsSync)||'python3';\nconst r=spawnSync(python,['-m','pytest','evaluation/test_evaluation.py','-q'],{stdio:'inherit',timeout:540000});\nif(r.error)console.error(r.error.message);\nprocess.exit(r.status??1);\n",
  'evaluation/config.json':JSON.stringify({dataset:{source:dataset.source,...(dataset.reference?{reference:dataset.reference}:{})},evaluator:{type:evaluator.type,...(evaluator.id?{id:evaluator.id}:{})},status:'NOT_RUN'},null,2)+'\n',
  'evaluation/README.md':assets['README.md'],
  'evaluation/requirements.txt':'pytest>=8,<9\nboto3>=1.42,<2\n',
  'evaluation/test_evaluation.py':assets['test_evaluation.py'],
  'evaluation/agent_adapter.py':assets['agent_adapter.py'],
  'evaluation/evaluator.py':evaluator.type==='python'?evaluator.code:evaluator.type==='agentcore'?assets['agentcore_evaluator.py']:assets['evaluator.py'],
  '.github/workflows/eval.yml':assets['evaluate.yml'],
 };
 if(dataset.source==='upload')files['evaluation/dataset.jsonl']=dataset.content;
 if(dataset.source==='blueprint'){
   const content=starterDataset||JSON.stringify({id:'starter-clarification',input:'Help me with an unspecified task.',expected:'?'})+'\n';
   files['evaluation/dataset.jsonl']=validateEvaluation({dataset:{source:'upload',content},evaluator:{type:'later'}}).dataset.content;
 }
 return Object.entries(files).map(([path,content])=>({path,content,mode:'100644'}));
}
