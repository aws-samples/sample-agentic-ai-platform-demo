// Portable, bounded export configuration. Uploaded code is never executed here.
export const defaultEvaluation = () => ({dataset:{source:'later'},evaluator:{type:'later'}});
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!/[\u0000]/.test(x);
export function validateEvaluation(value=defaultEvaluation()) {
  if(!exact(value,['dataset','evaluator'])||!exact(value.dataset,['source','content','reference'])||!exact(value.evaluator,['type','code','id']))throw Error('Invalid evaluation configuration.');
  if(new TextEncoder().encode(JSON.stringify(value)).length>48000)throw Error('Evaluation configuration exceeds the 48 KB request limit.');
  const {dataset:d,evaluator:e}=value;
  if(!['later','blueprint','upload','reference'].includes(d.source)||!['later','builtin','python','agentcore'].includes(e.type))throw Error('Choose a supported dataset and evaluator.');
  const dataset={source:d.source},evaluator={type:e.type};
  if(d.source==='upload'){
    if(!text(d.content,24000))throw Error('Upload a JSONL dataset of at most 24 KB.');
    const rows=d.content.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    if(!rows.length||rows.length>200||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!exact(r,['id','input','expected'])||!text(r.id,100)||!text(r.input,10000)||(r.expected!==undefined&&!text(r.expected,10000))))throw Error('Dataset requires up to 200 unique id/input cases, with optional expected text.');
    dataset.content=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
  }
  if(d.source==='reference'){
    if(!text(d.reference,1024)||!/^s3:\/\/[^\s?#]+$/.test(d.reference))throw Error('Use an S3 dataset reference without credentials or query parameters.');
    dataset.reference=d.reference;
  }
  if(e.type==='python'){
    if(!text(e.code,16000))throw Error('Provide a Python evaluator file, at most 16 KB.');
    evaluator.code=e.code;
  }
  if(e.type==='agentcore'){
    if(!text(e.id,256)||!/^[A-Za-z0-9._:-]+$/.test(e.id))throw Error('Provide an AgentCore built-in or custom evaluator ID.');
    evaluator.id=e.id;
  }
  return {dataset,evaluator};
}
