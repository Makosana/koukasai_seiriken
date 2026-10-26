// supabase/migrations/001_init.sql と 002_children.sql を埋め込みPostgres（PGlite）で実行し、Wi-Fi版と同じルールになっているか確かめる。
// Supabase のアカウントは不要です。auth.uid() は request.jwt.claim.sub を読む簡易版に置き換えます。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const migrations=['001_init.sql','002_children.sql','003_name.sql'].map(f=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8'));
const STAFF='00000000-0000-4000-8000-000000000001';
const jst=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
const day=offset=>jst.format(new Date(Date.now()+offset*86400000));

async function setup(){
  const db=new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;`);
  for(const m of migrations)await db.exec(m);
  return db;
}
async function as(db,role,sql,params=[]){
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${role==='staff'?STAFF:''}', false); set role ${role==='staff'?'authenticated':'anon'};`);
  try{return (await db.query(sql,params)).rows[0];}
  finally{await db.exec('reset role');}
}
const call=async(db,role,fn,args=[])=>{
  const row=await as(db,role,`select public.${fn}(${args.map((_,i)=>`$${i+1}`).join(',')}) as r`,args);
  return row.r;
};
async function fails(promise,code){
  await assert.rejects(promise,e=>{assert.equal(e.hint,code,`expected ${code}, got ${e.hint}: ${e.message}`);return true;});
}
const kids=n=>JSON.stringify({high_school:n});
const op=(db,body)=>call(db,'staff','admin_operation',[JSON.stringify(body)]);
const round={action:'create',label:'第1回',startsTime:'23:59',opensTime:'00:00',closesTime:'23:59',capacity:10,maxParty:4,finishAfterMinutes:0};

test('来場者は表を直接読めず、運営用の関数も呼べない', async()=>{
  const db=await setup();
  await assert.rejects(as(db,'anon','select * from public.tickets'),/permission denied/);
  await assert.rejects(as(db,'anon','select * from public.rounds'),/permission denied/);
  await assert.rejects(as(db,'staff','select * from public.tickets'),/permission denied/);
  await assert.rejects(call(db,'anon','admin_state'),/permission denied/);
  await assert.rejects(as(db,'anon',"select private.event_date()"),/permission denied/);
  const s=await call(db,'anon','public_state');
  assert.deepEqual(s.rounds,[]);
  assert.equal(s.eventDate,day(0));
});

test('受付前・受付中・一時停止・受付終了・終了した回の判定', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  const status=async()=>(await call(db,'anon','public_state')).rounds[0].status;
  assert.equal(await status(),'open');
  await op(db,{action:'pause',id});assert.equal(await status(),'paused');
  await op(db,{action:'resume',id});
  await op(db,{action:'settings',eventDate:day(1)});assert.equal(await status(),'before');
  await op(db,{action:'settings',eventDate:day(-1)});assert.equal(await status(),'finished');
  await op(db,{action:'settings',eventDate:day(0)});
  await op(db,{...round,action:'update',id,startsTime:'00:00',opensTime:'00:00',closesTime:'00:01',finishAfterMinutes:600});
  const [h,m]=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(':').map(Number);
  assert.equal(await status(),h*60+m>=600?'finished':'closed');
});

test('定員・人数上限・1端末1枚・同じ送信の再送・番号の連番', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  const issue=(party,device=randomUUID(),request=randomUUID())=>call(db,'anon','issue_ticket',[id,kids(party),0,'紅華 太郎',device,request]);
  const a=await issue(4);
  assert.equal(a.ticket.number,1);assert.equal(a.replayed,false);assert.ok(a.ticket.token);
  await fails(issue(5),'party');
  const device=randomUUID(),request=randomUUID();
  const b=await issue(3,device,request);
  assert.equal(b.ticket.number,2);
  const again=await issue(3,device,request);
  assert.equal(again.replayed,true);assert.equal(again.ticket.id,b.ticket.id);
  await fails(issue(3,randomUUID(),request),'request_conflict');
  await fails(issue(1,device),'already');
  await fails(issue(4),'remaining');
  const c=await issue(3);
  assert.equal(c.ticket.number,3);
  await fails(issue(1),'full');
  const s=(await call(db,'anon','public_state')).rounds[0];
  assert.equal(s.remaining,0);assert.equal(s.status,'full');
  assert.equal((await call(db,'anon','find_request',[request,device])).ticket.id,b.ticket.id);
  assert.equal((await call(db,'anon','find_request',[request,randomUUID()])).ticket,null);
  const looked=await call(db,'anon','lookup_tickets',[JSON.stringify([{id:a.ticket.id,token:a.ticket.token},{id:b.ticket.id,token:'wrong'},{id:'bad',token:'x'}])]);
  assert.equal(looked.tickets[0].number,1);assert.equal(looked.tickets[1],null);assert.equal(looked.tickets[2],null);
  await fails(call(db,'anon','lookup_tickets',[JSON.stringify(Array.from({length:31},()=>({id:a.ticket.id,token:'x'})))]),'invalid');
  await fails(call(db,'anon','issue_ticket',[999,kids(1),0,'紅華 太郎',randomUUID(),randomUUID()]),'not_found');
});

test('子どもの区分と保護者: 定員は子どもだけで数え、保護者は未就学児・小学生がいるときだけ記録する', async()=>{
  const db=await setup();
  const {id}=await op(db,{...round,capacity:6,maxParty:3});
  const send=(children,guardians=0,name='山田 花子')=>call(db,'anon','issue_ticket',[id,JSON.stringify(children),guardians,name,randomUUID(),randomUUID()]);
  const a=(await send({preschool:1,elementary:2},2,'  紅華 花子  ')).ticket;
  assert.equal(a.party_size,3);assert.equal(a.guardians,2);assert.equal(a.name,'紅華 花子');
  await fails(send({high_school:1},0,'   '),'invalid');
  await fails(send({high_school:1},0,null),'invalid');
  await fails(send({high_school:1},0,'あ'.repeat(31)),'invalid');
  await fails(send({high_school:1},0,'a\nb'),'invalid');
  assert.deepEqual(a.children,{preschool:1,elementary:2,junior_high:0,high_school:0});
  assert.equal((await call(db,'anon','public_state')).rounds[0].remaining,3);
  assert.equal((await send({junior_high:1,high_school:1},3)).ticket.guardians,0);
  await fails(send({junior_high:4}),'party');
  await fails(send({}),'invalid');
  await fails(send({elementary:1},11),'invalid');
  await fails(send({elementary:-1,high_school:2}),'invalid');
  await fails(send({elementary:1.5}),'invalid');
  await fails(send({elementary:'1'}),'invalid');
  await fails(call(db,'anon','issue_ticket',[id,'[1]',0,'紅華 太郎',randomUUID(),randomUUID()]),'invalid');
  await fails(send({preschool:2}),'remaining');
  await send({preschool:1});
  const state=await call(db,'staff','admin_state');
  assert.equal(state.rounds[0].used_people,6);assert.equal(state.rounds[0].used_guardians,2);
  assert.equal(state.totals.guardians,2);assert.equal(state.rounds[0].status,'full');
  const rows=await call(db,'staff','admin_export_tickets');
  const first=rows.find(r=>r.number===1);
  assert.equal(first.preschool,1);assert.equal(first.elementary,2);assert.equal(first.guardians,2);assert.equal(first.name,'紅華 花子');
  assert.equal((await call(db,'staff','admin_list_tickets',[id,1])).tickets[0].name,'紅華 花子');
  await assert.rejects(db.query('update public.tickets set guardians=5'),/取消以外/);
  await assert.rejects(db.query("update public.tickets set name='x'"),/取消以外/);
});

test('取消: 本人は開演前だけ、スタッフはいつでも。取消番号は再利用しない', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  const device=randomUUID();
  const t=(await call(db,'anon','issue_ticket',[id,kids(2),0,'紅華 太郎',device,randomUUID()])).ticket;
  await fails(call(db,'anon','cancel_ticket',[t.id,'wrong']),'forbidden');
  const done=await call(db,'anon','cancel_ticket',[t.id,t.token]);
  assert.equal(done.ticket.status,'cancelled');assert.equal(done.ticket.cancelled_by,'visitor');
  assert.equal((await call(db,'anon','cancel_ticket',[t.id,t.token])).replayed,true);
  const next=(await call(db,'anon','issue_ticket',[id,kids(2),0,'紅華 太郎',device,randomUUID()])).ticket;
  assert.equal(next.number,2);
  await op(db,{...round,action:'update',id,startsTime:'00:00',finishAfterMinutes:600});
  await fails(call(db,'anon','cancel_ticket',[next.id,next.token]),'started');
  const staff=await call(db,'staff','admin_cancel',[next.id]);
  assert.equal(staff.ticket.cancelled_by,'staff');assert.equal(staff.ticket.device,device.slice(0,8));
  const list=await call(db,'staff','admin_list_tickets',[id,null]);
  assert.deepEqual(list.tickets.map(x=>x.number),[2,1]);
  assert.equal((await call(db,'staff','admin_list_tickets',[id,2])).tickets.length,1);
  const rows=await call(db,'staff','admin_export_tickets');
  assert.equal(rows.length,2);assert.equal(rows[0].label,'第1回');
  const state=await call(db,'staff','admin_state');
  assert.equal(state.totals.cancelled,2);assert.equal(state.rounds[0].last_number,2);
});

test('運営操作の検証と記録の保護', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  await call(db,'anon','issue_ticket',[id,kids(4),0,'紅華 太郎',randomUUID(),randomUUID()]);
  await fails(op(db,{...round,action:'update',id,capacity:3}),'invalid');
  await fails(op(db,{action:'delete',id}),'invalid');
  await fails(op(db,{action:'settings',eventDate:'2026-02-30'}),'invalid');
  await fails(op(db,{...round,action:'create',opensTime:'10:00',closesTime:'09:00'}),'invalid');
  await fails(op(db,{...round,action:'create',capacity:1.5}),'invalid');
  await fails(op(db,{...round,action:'create',capacity:'10'}),'invalid');
  await fails(op(db,{...round,action:'create',label:' '}),'invalid');
  const empty=await op(db,{...round,label:'空の回'});
  await op(db,{action:'delete',id:empty.id});
  await assert.rejects(db.query('delete from public.tickets'),/削除できません/);
  await assert.rejects(db.query("update public.tickets set party_size=1"),/取消以外/);
  await assert.rejects(db.query('delete from public.operations'),/変更・削除できません/);
  const log=await db.query('select action, actor from public.operations order by id');
  assert.deepEqual(log.rows.map(r=>r.action),['create','create','delete']);
  assert.equal(log.rows[0].actor,STAFF);
});
