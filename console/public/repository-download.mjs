const encode = value => new TextEncoder().encode(value);
const table = Array.from({length:256}, (_,n) => {
  for(let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1;
  return n>>>0;
});
const crc32 = bytes => {
  let crc=0xffffffff;
  for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
};
const header = size => {
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  return {bytes,u16:(p,n)=>view.setUint16(p,n,true),u32:(p,n)=>view.setUint32(p,n,true)};
};
const concatenate = parts => {
  const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
};

// Stored ZIP entries need no compression library or network dependency.
// Verify the server manifest before writing any archive bytes.
export async function repositoryArchive(manifest) {
  if(!manifest || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length>2000)throw new Error('Repository manifest is invalid.');
  const seen=new Set();
  let total=0;
  const entries=manifest.entries.map(({path,content,mode})=>{
    if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f:]/.test(path)
      ||path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(path)
      ||typeof content!=='string'||!['100644','100755'].includes(mode))throw new Error('Repository file is invalid.');
    seen.add(path);
    const name=encode(path),data=encode(content);total+=name.length+data.length;
    if(name.length>65535||total>16*1024*1024)throw new Error('Repository archive is too large.');
    return {path,content,mode,name,data};
  });
  const canonical=JSON.stringify(entries.map(({path,content,mode})=>({path,content,mode})));
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(canonical))),n=>n.toString(16).padStart(2,'0')).join('');
  if(fingerprint!==manifest.fingerprint)throw new Error('Repository fingerprint does not match. Create a fresh preview.');
  const local=[],central=[];let offset=0;
  for(const {name,data,mode} of entries){
    const crc=crc32(data),file=header(30);
    file.u32(0,0x04034b50);file.u16(4,20);file.u16(6,0x800);file.u16(12,33);
    file.u32(14,crc);file.u32(18,data.length);file.u32(22,data.length);file.u16(26,name.length);
    local.push(file.bytes,name,data);
    const directory=header(46);
    directory.u32(0,0x02014b50);directory.u16(4,0x0314);directory.u16(6,20);directory.u16(8,0x800);directory.u16(14,33);
    directory.u32(16,crc);directory.u32(20,data.length);directory.u32(24,data.length);directory.u16(28,name.length);
    directory.u32(38,(parseInt(mode,8)<<16)>>>0);directory.u32(42,offset);
    central.push(directory.bytes,name);offset+=30+name.length+data.length;
  }
  const directory=concatenate(central),end=header(22);
  end.u32(0,0x06054b50);end.u16(8,entries.length);end.u16(10,entries.length);end.u32(12,directory.length);end.u32(16,offset);
  return concatenate([...local,directory,end.bytes]);
}
