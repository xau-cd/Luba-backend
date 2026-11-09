const http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),assert=require('assert');
process.env.UPLOAD_MAX_FILE_MB='5'; process.env.UPLOAD_CHUNK_KB='64';
const {createUploadService,createUploadRouter}=require('../luba-upload.js');
// mini express shim
const routes=[];const Router=()=>{const r={};for(const m of['get','post','put','delete'])r[m]=(p,...hs)=>routes.push({m:m.toUpperCase(),re:new RegExp('^'+p.replace(/:\w+/g,'([^/]+)')+'$'),names:(p.match(/:\w+/g)||[]).map(s=>s.slice(1)),hs});return r};
const router=createUploadRouter({Router},(req,res,n)=>{req.userId=req.headers['x-u']||'userA';n()},createUploadService({DIR:fs.mkdtempSync(path.join(os.tmpdir(),'lu-'))}));
const svc=createUploadService({DIR:fs.mkdtempSync(path.join(os.tmpdir(),'lu2-'))});
// re-create router with svc we control
routes.length=0;
createUploadRouter({Router},(req,res,n)=>{req.userId=req.headers['x-u']||'userA';n()},svc);
const srv=http.createServer((req,res)=>{
  res.status=c=>{res.statusCode=c;return res};res.json=o=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(o))};
  const url=req.url.split('?')[0];
  for(const r of routes){if(r.m!==req.method)continue;const m=r.re.exec(url);if(!m)continue;req.params={};r.names.forEach((n,i)=>req.params[n]=m[i+1]);
    const run=(i)=>{if(i>=r.hs.length)return;const h=r.hs[i];
      if(i===r.hs.length-1&&req.method==='POST'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{req.body=JSON.parse(b||'{}');h(req,res)});return}
      h(req,res,()=>run(i+1))};run(0);return}
  res.statusCode=404;res.end('{}')});
const req=(method,p,{headers={},body}={})=>new Promise(ok=>{const rq=http.request({port:srv.address().port,method,path:p,headers},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>ok({s:r.statusCode,j:d?JSON.parse(d):{}}))});if(body)rq.write(body);rq.end()});
async function up(name,buf,u='userA',conv='conv_abc123'){
  const i=await req('POST','/api/uploads',{headers:{'x-u':u,'content-type':'application/json'},body:JSON.stringify({name,size:buf.length,conversationId:conv})});
  if(i.s!==201)return i;let off=0,last;
  while(off<buf.length){const e=Math.min(off+i.j.chunkBytes,buf.length);
    last=await req('PUT','/api/uploads/'+i.j.uploadId,{headers:{'x-u':u,'content-range':`bytes ${off}-${e-1}/${buf.length}`,'content-type':'application/octet-stream'},body:buf.subarray(off,e)});
    if(last.s!==200)return last;off=last.j.offset}
  return last}
srv.listen(0,async()=>{try{
 let r=await up('note.txt',Buffer.from('Héllo é€ LUBA'));assert(r.j.complete,'txt');console.log('txt OK',r.j.file.name);
 const txt=await svc.readText('userA','conv_abc123',r.j.file.fileId);assert.strictEqual(txt.text,'Héllo é€ LUBA');console.log('readText UTF-8 OK');
 r=await up('a.pdf',Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(300000,1)]));assert(r.j.complete);console.log('pdf 300KB multi-chunk OK');
 r=await up('b.png',Buffer.from('not a png at all'));assert.strictEqual(r.j.code,'SIGNATURE_MISMATCH');console.log('fake png rejected OK');
 r=await up('x.exe',Buffer.from('MZ'));assert.strictEqual(r.s,415);console.log('exe rejected OK');
 r=await up('big.txt',Buffer.alloc(6*1048576,97));assert.strictEqual(r.s,413);console.log('>max rejected OK',r.j.reply);
 r=await up('../../etc/passwd.txt',Buffer.from('x'));assert(r.j.file.name==='passwd.txt');console.log('path traversal name sanitized OK');
 r=await up('t.txt',Buffer.from('x'),'userA','../evil');assert.strictEqual(r.s,400);console.log('bad conv id rejected OK');
 // resume + wrong offset
 const buf=Buffer.alloc(200000,65);let i=await req('POST','/api/uploads',{headers:{'x-u':'userA','content-type':'application/json'},body:JSON.stringify({name:'r.csv',size:buf.length,conversationId:'conv_abc123'})});
 const id=i.j.uploadId;await req('PUT','/api/uploads/'+id,{headers:{'x-u':'userA','content-range':`bytes 0-65535/200000`},body:buf.subarray(0,65536)});
 let st=await req('GET','/api/uploads/'+id,{headers:{'x-u':'userA'}});assert.strictEqual(st.j.offset,65536);
 let bad=await req('PUT','/api/uploads/'+id,{headers:{'x-u':'userA','content-range':`bytes 0-65535/200000`},body:buf.subarray(0,65536)});assert.strictEqual(bad.s,409);assert.strictEqual(bad.j.offset,65536);console.log('resume/409 resync OK');
 let other=await req('GET','/api/uploads/'+id,{headers:{'x-u':'userB'}});assert.strictEqual(other.s,404);console.log('cross-user access blocked OK');
 let short=await req('PUT','/api/uploads/'+id,{headers:{'x-u':'userA','content-range':`bytes 65536-131071/200000`},body:buf.subarray(0,100)});assert.strictEqual(short.s,400);
 st=await req('GET','/api/uploads/'+id,{headers:{'x-u':'userA'}});assert.strictEqual(st.j.offset,65536);console.log('truncated chunk rolled back OK');
 await req('DELETE','/api/uploads/'+id,{headers:{'x-u':'userA'}});st=await req('GET','/api/uploads/'+id,{headers:{'x-u':'userA'}});assert.strictEqual(st.s,404);console.log('cancel OK');
 /*docx test omitted*/
 const fl=await req('GET','/api/conversations/conv_abc123/files',{headers:{'x-u':'userA'}});console.log('list',fl.j.files.length,'files');
 await req('DELETE','/api/conversations/conv_abc123/files/'+fl.j.files[0].fileId,{headers:{'x-u':'userA'}});
 const fl2=await req('GET','/api/conversations/conv_abc123/files',{headers:{'x-u':'userA'}});assert.strictEqual(fl2.j.files.length,fl.j.files.length-1);console.log('delete file OK');
 console.log('ALL PASS')}catch(e){console.error('FAIL',e);process.exitCode=1}srv.close()});
