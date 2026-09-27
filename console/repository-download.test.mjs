import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repositoryArchive} from './public/repository-download.mjs';
const manifest=entries=>({entries,fingerprint:createHash('sha256').update(JSON.stringify(entries)).digest('hex')});
test('downloaded project extracts with exact Unicode content and executable file mode',async()=>{
  const entries=[{path:'AGENTS.md',content:'Read the project instructions.\n',mode:'100644'},
    {path:'src/café.mjs',content:'console.log("héllo");\n',mode:'100755'}];
  const dir=await mkdtemp(join(tmpdir(),'platform-archive-'));
  try{
    await writeFile(join(dir,'project.zip'),await repositoryArchive(manifest(entries)));
    execFileSync('unzip',['-q','project.zip','-d','project'],{cwd:dir});
    for(const e of entries)assert.equal(await readFile(join(dir,'project',e.path),'utf8'),e.content);
    assert.ok((await stat(join(dir,'project/src/café.mjs'))).mode&0o100);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('archive rejects modified contents, traversal and duplicate paths',async()=>{
  const file={path:'README.md',content:'original',mode:'100644'};
  const changed=manifest([file]);changed.entries=[{...file,content:'tampered'}];
  await assert.rejects(repositoryArchive(changed),/fingerprint/);
  for(const path of ['../outside','/absolute','folder/../outside','C:/outside','folder\\outside'])
    await assert.rejects(repositoryArchive(manifest([{...file,path} ])),/invalid/);
  await assert.rejects(repositoryArchive(manifest([file,file])),/invalid/);
});
