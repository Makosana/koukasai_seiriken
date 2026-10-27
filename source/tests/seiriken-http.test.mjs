import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir,networkInterfaces} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {Agent,request as httpRequest} from 'node:http';
import {startApplication} from '../backend/server.mjs';

const packageRoot=process.env.SEIRIKEN_OUTPUT?resolve(process.env.SEIRIKEN_OUTPUT):resolve('..');
const publicDirectory=join(packageRoot,'app/public');
const at=hhmm=>new Date(`2026-11-03T${hhmm}:00+09:00`);

async function setup(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'seiriken-'));
  const clock={current:at('09:30')};
  const make=()=>startApplication({root:dir,publicDirectory,port:0,now:()=>clock.current,issueRateLimit:100000,...options});
  const app=await make();const applications=[app];
  t.after(async()=>{for(const instance of applications)await instance.close();rmSync(dir,{recursive:true,force:true});});
  return {app,dir,clock,make:async()=>{const instance=await make();applications.push(instance);return instance;}};
}
async function call(base,path,body,headers={}){
  const r=await fetch(base+path,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json','X-Seiriken-Request':'1',...headers},body:JSON.stringify(body)});
  return {status:r.status,headers:r.headers,value:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
}
const admin=(app,body)=>call(app.url,'api/admin/operation',body);
const issue=(app,roundId,partySize=1,deviceId=randomUUID(),requestId=randomUUID())=>call(app.url,'api/public/issue',{roundId,children:{high_school:partySize},deviceId,requestId});
const publicRound=async(app,id)=>(await call(app.url,'api/public/state')).value.rounds.find(r=>r.id===id);
async function addRound(app,extra={}){
  const r=await admin(app,{action:'create',label:'10:00の回',startsTime:'10:00',opensTime:'09:00',closesTime:'10:00',capacity:10,maxParty:4,finishAfterMinutes:30,...extra});
  assert.equal(r.status,200,JSON.stringify(r.value));return r.value.id;
}

test('アカウント・ネット接続なしの起動、DB自動作成、画面と全ローカル資産',async t=>{
  const {app,dir}=await setup(t);
  const s=await call(app.url,'api/public/state');
  assert.equal(s.status,200);assert.deepEqual(s.value.rounds,[]);assert.equal(s.value.eventDate,'2026-11-03');
  assert.ok(existsSync(join(dir,'data/seiriken.sqlite3')));
  assert.ok(readdirSync(join(dir,'backups')).some(x=>x.endsWith('_startup.sqlite3')));
  if(!existsSync(join(publicDirectory,'index.html'))){t.diagnostic('app/public が未ビルドのため画面資産の確認は省略');return;}
  const r=await fetch(app.url),html=await r.text();
  assert.equal(r.status,200);assert.match(html,/紅華祭/);assert.doesNotMatch(html,/<(?:script|link)[^>]+(?:src|href)="https?:/);
  for(const path of Array.from(html.matchAll(/(?:src|href)="(\/[^"]+)"/g),m=>m[1]))assert.equal((await fetch(new URL(path,app.url))).status,200,path);
});

test('受付時間・一時停止・終了の状態はその都度計算する',async t=>{
  const {app,clock}=await setup(t);const id=await addRound(app);
  clock.current=at('08:59');
  assert.equal((await publicRound(app,id)).status,'before');
  assert.equal((await issue(app,id)).value.code,'before');
  clock.current=at('09:00');
  assert.equal((await publicRound(app,id)).status,'open');
  assert.equal((await admin(app,{action:'pause',id})).status,200);
  assert.equal((await publicRound(app,id)).status,'paused');
  assert.equal((await issue(app,id)).value.code,'paused');
  await admin(app,{action:'resume',id});
  assert.equal((await issue(app,id)).status,200);
  clock.current=at('10:00');
  assert.equal((await publicRound(app,id)).status,'closed');
  assert.equal((await issue(app,id)).value.code,'closed');
  clock.current=at('10:30');
  assert.equal((await publicRound(app,id)).status,'finished');
});

test('人数で定員を数え、1枚の上限・端末ごとの制限・再送の一件化を守る',async t=>{
  const {app}=await setup(t);const id=await addRound(app),other=await addRound(app,{label:'11:00の回',startsTime:'11:00',closesTime:'11:00'});
  const device=randomUUID(),requestId=randomUUID();
  const first=await issue(app,id,4,device,requestId);
  assert.equal(first.status,200);assert.equal(first.value.ticket.number,1);assert.ok(first.value.ticket.token);
  const replay=await issue(app,id,4,device,requestId);
  assert.equal(replay.value.replayed,true);assert.equal(replay.value.ticket.id,first.value.ticket.id);
  assert.equal((await issue(app,id,1,randomUUID(),requestId)).value.code,'request_conflict');
  assert.equal((await issue(app,id,1,device)).value.code,'already');
  assert.equal((await issue(app,other,1,device)).status,200);
  assert.equal((await issue(app,id,5)).value.code,'party');
  assert.equal((await issue(app,id,4)).value.ticket.number,2);
  assert.equal((await publicRound(app,id)).remaining,2);
  assert.equal((await issue(app,id,3)).value.code,'remaining');
  assert.equal((await issue(app,id,2)).status,200);
  const full=await publicRound(app,id);assert.equal(full.remaining,0);assert.equal(full.status,'full');
  assert.equal((await issue(app,id,1)).value.code,'full');
});

test('子どもの区分と保護者: 定員と1枚の上限は子どもだけで数え、保護者は未就学児・小学生がいるときだけ記録する',async t=>{
  const {app}=await setup(t);const id=await addRound(app,{capacity:6,maxParty:3});
  const send=(body)=>call(app.url,'api/public/issue',{roundId:id,deviceId:randomUUID(),requestId:randomUUID(),...body});
  const a=await send({children:{preschool:1,elementary:2},guardians:2,name:'紅華 花子'});
  assert.equal(a.status,200,JSON.stringify(a.value));
  assert.equal('name' in a.value.ticket,false);
  assert.equal(a.value.ticket.party_size,3);assert.equal(a.value.ticket.guardians,2);
  assert.deepEqual(a.value.ticket.children,{preschool:1,elementary:2,junior_high:0,high_school:0});
  assert.equal((await publicRound(app,id)).remaining,3);
  const b=await send({children:{junior_high:1,high_school:1},guardians:3});
  assert.equal(b.value.ticket.guardians,0);
  assert.equal((await send({children:{junior_high:4}})).value.code,'party');
  assert.equal((await send({children:{}})).status,400);
  assert.equal((await send({children:{elementary:1},guardians:11})).status,400);
  assert.equal((await send({children:{elementary:-1,high_school:2}})).status,400);
  assert.equal((await send({children:{elementary:1.5}})).status,400);
  assert.equal((await send({children:{preschool:2}})).value.code,'remaining');
  assert.equal((await send({children:{preschool:1},guardians:0})).status,200);
  const state=(await call(app.url,'api/admin/state')).value;
  const r=state.rounds.find(x=>x.id===id);
  assert.equal(r.used_people,6);assert.equal(r.used_guardians,2);assert.equal(state.totals.guardians,2);assert.equal(r.status,'full');
  const list=(await call(app.url,`api/admin/tickets?round=${id}`)).value.tickets;
  assert.deepEqual(list.map(x=>x.guardians),[0,0,2]);
  assert.ok(list.every(x=>!('name' in x)));
  const csv=(await (await fetch(app.url+'api/admin/csv')).text()).replace(/^\uFEFF/,'').split('\r\n');
  assert.equal(csv[0],'回,開演,番号,子ども,未就学児,小学生,中学生,高校生,保護者,状態,発行時刻,取消時刻,取り消した人,整理券ID');
  assert.match(csv[1],/^10:00の回,10:00,1,3,1,2,0,0,2,有効,/);
  assert.match(csv[2],/^10:00の回,10:00,2,2,0,0,1,1,0,有効,/);
  assert.equal(app.storage.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets WHERE name<>''").get().n,0);
});

test('v1のデータは、起動時に区分・保護者の列を追加して引き継ぐ',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'seiriken-old-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const schema=readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8');
  const {createHash}=await import('node:crypto');
  const old=new DatabaseSync(join(dir,'seiriken.sqlite3'));
  old.exec(schema);
  old.exec('CREATE TABLE app_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL); CREATE TABLE app_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  old.prepare('INSERT INTO app_migrations VALUES(1,?)').run(createHash('sha256').update(schema).digest('hex'));
  old.exec("INSERT INTO rounds(label,starts_time,opens_time,closes_time,capacity_people,created_at,updated_at) VALUES('旧','10:00','09:00','10:00',10,'x','x')");
  old.exec("INSERT INTO tickets(id,round_id,number,party_size,device_id,request_id,cancel_token,created_at) VALUES('00000000-0000-4000-8000-000000000001',1,1,2,'d','00000000-0000-4000-8000-000000000002','tok','2026-11-03T00:00:00.000Z')");
  old.close();
  const {openStorage}=await import('../backend/storage.mjs');
  const {fileURLToPath}=await import('node:url');
  const storage=openStorage(dir,fileURLToPath(new URL('../backend/schema.sql',import.meta.url)));
  try{
    const row=storage.sqlite.prepare('SELECT party_size,preschool,guardians,name FROM tickets').get();
    assert.deepEqual({...row},{party_size:2,preschool:0,guardians:0,name:''});
    assert.equal(storage.sqlite.prepare('SELECT MAX(version) AS v FROM app_migrations').get().v,4);
    assert.throws(()=>storage.sqlite.prepare('UPDATE tickets SET guardians=3').run(),/取消以外/);
    assert.throws(()=>storage.sqlite.prepare("UPDATE tickets SET name='x'").run(),/取消以外/);
  }finally{storage.close();}
});

test('v3で記録した名前は、起動時に消す',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'seiriken-v3-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {createHash}=await import('node:crypto');
  const {fileURLToPath}=await import('node:url');
  const backend=new URL('../backend/',import.meta.url);
  const files=['schema.sql','migrations/002_children.sql','migrations/003_name.sql'].map(f=>readFileSync(new URL(f,backend),'utf8'));
  const old=new DatabaseSync(join(dir,'seiriken.sqlite3'));
  old.exec('CREATE TABLE app_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL); CREATE TABLE app_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  files.forEach((sql,i)=>{old.exec(sql);old.prepare('INSERT INTO app_migrations VALUES(?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'));});
  old.exec("INSERT INTO rounds(label,starts_time,opens_time,closes_time,capacity_people,created_at,updated_at) VALUES('旧','10:00','09:00','10:00',10,'x','x')");
  old.exec("INSERT INTO tickets(id,round_id,number,party_size,high_school,name,device_id,request_id,cancel_token,created_at) VALUES('00000000-0000-4000-8000-000000000001',1,1,1,1,'紅華 花子','d','00000000-0000-4000-8000-000000000002','tok','2026-11-03T00:00:00.000Z')");
  old.close();
  const {openStorage}=await import('../backend/storage.mjs');
  const storage=openStorage(dir,fileURLToPath(new URL('schema.sql',backend)));
  try{
    assert.equal(storage.sqlite.prepare('SELECT name FROM tickets').get().name,'');
    storage.sqlite.prepare("UPDATE tickets SET status='cancelled',cancelled_at='x',cancelled_by='staff'").run();
    assert.equal(storage.sqlite.prepare('SELECT status FROM tickets').get().status,'cancelled');
  }finally{storage.close();}
});

test('取消: 本人は開演前まで、スタッフはいつでも。番号は再利用しない',async t=>{
  const {app,clock}=await setup(t);const id=await addRound(app);
  const device=randomUUID();
  const a=(await issue(app,id,2,device)).value.ticket,b=(await issue(app,id,3)).value.ticket;
  assert.equal((await call(app.url,'api/public/cancel',{id:a.id,token:'wrong'})).status,403);
  const cancelled=await call(app.url,'api/public/cancel',{id:a.id,token:a.token});
  assert.equal(cancelled.status,200);assert.equal(cancelled.value.ticket.status,'cancelled');assert.equal(cancelled.value.ticket.cancelled_by,'visitor');
  assert.equal((await publicRound(app,id)).remaining,7);
  const again=await issue(app,id,1,device);
  assert.equal(again.status,200);assert.equal(again.value.ticket.number,3);
  clock.current=at('10:00');
  assert.equal((await call(app.url,'api/public/cancel',{id:b.id,token:b.token})).value.code,'started');
  assert.equal((await call(app.url,'api/admin/cancel',{id:b.id})).status,200);
  const looked=await call(app.url,'api/public/tickets',{items:[{id:b.id,token:b.token},{id:a.id,token:'bad'}]});
  assert.equal(looked.value.tickets[0].status,'cancelled');assert.equal(looked.value.tickets[0].cancelled_by,'staff');assert.equal(looked.value.tickets[1],null);
  const found=await call(app.url,'api/public/request',{requestId:randomUUID(),deviceId:device});
  assert.equal(found.value.ticket,null);
});

function rawIssue(app,agent,body){
  return new Promise((resolveRequest,reject)=>{
    const payload=JSON.stringify(body);
    const req=httpRequest(app.url+'api/public/issue',{method:'POST',agent,headers:{'Content-Type':'application/json','X-Seiriken-Request':'1','Content-Length':Buffer.byteLength(payload)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolveRequest({status:res.statusCode,value:JSON.parse(text)}));
    });
    req.on('error',reject);req.end(payload);
  });
}

test('同時に400件の申し込みが来ても、番号の重複と定員超えが起きない',async t=>{
  const {app}=await setup(t);const id=await addRound(app,{capacity:100});
  // Windows caps the TCP accept queue (~200), so 400 requests share 100 concurrent connections.
  const agent=new Agent({keepAlive:true,maxSockets:100});t.after(()=>agent.destroy());
  const sizes=Array.from({length:400},(_,i)=>i%4+1);
  const results=await Promise.all(sizes.map(n=>rawIssue(app,agent,{roundId:id,children:{elementary:n},guardians:1,deviceId:randomUUID(),requestId:randomUUID()})));
  const ok=results.filter(r=>r.status===200).map(r=>r.value.ticket);
  assert.ok(results.every(r=>r.status===200||r.status===409),JSON.stringify(results.find(r=>r.status!==200&&r.status!==409)?.value));
  const people=ok.reduce((s,t)=>s+t.party_size,0);
  assert.ok(people<=100,`定員超え: ${people}`);assert.ok(people>=97,`空きが多すぎる: ${people}`);
  const numbers=ok.map(t=>t.number).sort((a,b)=>a-b);
  assert.deepEqual(numbers,numbers.map((_,i)=>i+1));
  const state=(await call(app.url,'api/admin/state')).value.rounds.find(r=>r.id===id);
  assert.equal(state.used_people,people);assert.equal(state.active_count,ok.length);
});

test('運営操作の検証: 発行済み人数より少ない定員・発行済みの回の削除・不正な日付を拒否',async t=>{
  const {app}=await setup(t);const id=await addRound(app);
  await issue(app,id,4);
  const base={action:'update',id,label:'10:00の回',startsTime:'10:00',opensTime:'09:00',closesTime:'10:00',maxParty:4,finishAfterMinutes:30};
  assert.equal((await admin(app,{...base,capacity:3})).status,409);
  assert.equal((await admin(app,{...base,capacity:4})).status,200);
  assert.equal((await admin(app,{...base,capacity:20,opensTime:'10:00'})).status,400);
  assert.equal((await admin(app,{action:'delete',id})).status,409);
  assert.equal((await admin(app,{action:'settings',eventDate:'2026-02-30'})).status,400);
  assert.equal((await admin(app,{action:'settings',eventDate:'2026-11-04'})).status,200);
  assert.equal((await publicRound(app,id)).status,'before');
  const spare=await addRound(app,{label:'予備'});
  assert.equal((await admin(app,{action:'delete',id:spare})).status,200);
  assert.equal((await call(app.url,'api/public/issue',{roundId:id,children:{high_school:1},deviceId:'x',requestId:randomUUID()})).status,400);
  const noHeader=await fetch(app.url+'api/public/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(noHeader.status,403);
  const foreign=await call(app.url,'api/admin/operation',{action:'pause',id},{Origin:'http://evil.example'});
  assert.equal(foreign.status,403);
});

test('再起動後も記録を保持し、CSVはexportsにも保存、自動バックアップは整合',async t=>{
  const {app,dir,make}=await setup(t);const id=await addRound(app,{capacity:200,maxParty:1});
  const first=(await issue(app,id,1)).value.ticket;
  for(let i=0;i<20;i++)assert.equal((await issue(app,id,1)).status,200);
  await app.close();
  const again=await make();
  const looked=await call(again.url,'api/public/tickets',{items:[{id:first.id,token:first.token}]});
  assert.equal(looked.value.tickets[0].number,1);
  assert.equal((await issue(again,id,1)).value.ticket.number,22);
  const csv=await fetch(again.url+'api/admin/csv'),text=await csv.text();
  assert.equal(csv.status,200);
  const filename=csv.headers.get('content-disposition').match(/filename="([^"]+)"/)[1];
  const stored=readFileSync(join(dir,'exports',filename),'utf8');
  assert.equal(stored.replace(/^\uFEFF/,''),text.replace(/^\uFEFF/,''));assert.ok(stored.startsWith('\uFEFF'));assert.match(stored,/10:00の回/);assert.equal(stored.trim().split('\r\n').length,23);
  const backups=readdirSync(join(dir,'backups')).filter(x=>x.endsWith('.sqlite3'));
  assert.ok(backups.some(x=>x.endsWith('_auto.sqlite3')||x.endsWith('_shutdown.sqlite3')));
  const copy=new DatabaseSync(join(dir,'backups',backups.find(x=>x.endsWith('_shutdown.sqlite3'))),{readOnly:true});
  assert.equal(Object.values(copy.prepare('PRAGMA integrity_check').get())[0],'ok');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,21);
  copy.close();
  assert.throws(()=>again.storage.sqlite.prepare('DELETE FROM tickets').run(),/削除できません/);
  assert.throws(()=>again.storage.sqlite.prepare('UPDATE tickets SET party_size=9').run(),/取消以外/);
});

test('Wi-Fi経由: 来場者はコードなしで使え、運営画面はスタッフコードが必要',async t=>{
  const address=Object.values(networkInterfaces()).flat().find(a=>a?.family==='IPv4'&&!a.internal)?.address;
  if(!address){t.skip('LANのIPv4アドレスがない環境');return;}
  const {app}=await setup(t,{lan:true});
  const base=`http://${address}:${app.port}/`;
  assert.equal((await call(base,'api/public/state')).status,200);
  assert.equal((await call(base,'api/admin/state')).status,401);
  assert.equal((await call(base,'api/admin/login',{code:'00000000'})).status,403);
  const ok=await call(base,'api/admin/login',{code:app.storage.staffCode});
  assert.equal(ok.status,200);
  const cookie=ok.headers.get('set-cookie').split(';')[0];
  const s=await call(base,'api/admin/state',undefined,{Cookie:cookie});
  assert.equal(s.status,200);assert.equal(s.value.server.staffCode,null);
  assert.equal((await call(app.url,'api/admin/state')).value.server.staffCode,app.storage.staffCode);
  assert.equal((await fetch(base+'healthz')).status,403);
});
