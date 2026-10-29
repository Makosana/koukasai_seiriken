// supabase/migrations/ の SQL を順に埋め込みPostgres（PGlite）で実行し、Wi-Fi版と同じルールになっているか確かめる。
// Supabase のアカウントは不要です。auth.uid() は request.jwt.claim.sub を読む簡易版に置き換えます。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const migrations=['001_init.sql','002_children.sql','003_name.sql','004_checkin.sql','005_events_waitlist.sql','006_cancel_checked_in.sql','007_list_all_tickets.sql','008_wait_blocks_overlap.sql','009_wait_partial.sql','010_event_kinds.sql'].map(f=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8'));
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
  await db.exec("insert into public.events(label, venue) values ('ステージ', '体育館')");
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
const round={action:'create',eventId:1,label:'第1回',startsTime:'23:59',opensTime:'00:00',closesTime:'23:59',capacity:10,maxParty:4,finishAfterMinutes:0,durationMinutes:1};
// 時間の重なりを試す回。23時台に始まるので、このテストは日本時間23時より前に実行すること
const late={...round,opensTime:'00:00',closesTime:'23:59',finishAfterMinutes:600};

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
  const issue=(party,device=randomUUID(),request=randomUUID())=>call(db,'anon','issue_ticket',[id,kids(party),0,device,request]);
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
  await fails(call(db,'anon','issue_ticket',[999,kids(1),0,randomUUID(),randomUUID()]),'not_found');
});

test('子どもの区分と保護者: 定員は子どもだけで数え、保護者は未就学児・小学生がいるときだけ記録する', async()=>{
  const db=await setup();
  const {id}=await op(db,{...round,capacity:6,maxParty:3});
  const send=(children,guardians=0)=>call(db,'anon','issue_ticket',[id,JSON.stringify(children),guardians,randomUUID(),randomUUID()]);
  const a=(await send({preschool:1,elementary:2},2)).ticket;
  assert.equal(a.party_size,3);assert.equal(a.guardians,2);assert.equal('name' in a,false);
  assert.deepEqual(a.children,{preschool:1,elementary:2,junior_high:0,high_school:0});
  assert.equal((await call(db,'anon','public_state')).rounds[0].remaining,3);
  assert.equal((await send({junior_high:1,high_school:1},3)).ticket.guardians,0);
  await fails(send({junior_high:4}),'party');
  await fails(send({}),'invalid');
  await fails(send({elementary:1},11),'invalid');
  await fails(send({elementary:-1,high_school:2}),'invalid');
  await fails(send({elementary:1.5}),'invalid');
  await fails(send({elementary:'1'}),'invalid');
  await fails(call(db,'anon','issue_ticket',[id,'[1]',0,randomUUID(),randomUUID()]),'invalid');
  await fails(send({preschool:2}),'remaining');
  await send({preschool:1});
  const state=await call(db,'staff','admin_state');
  assert.equal(state.rounds[0].used_people,6);assert.equal(state.rounds[0].used_guardians,2);
  assert.equal(state.totals.guardians,2);assert.equal(state.rounds[0].status,'full');
  const rows=await call(db,'staff','admin_export_tickets');
  const first=rows.find(r=>r.number===1);
  assert.equal(first.preschool,1);assert.equal(first.elementary,2);assert.equal(first.guardians,2);assert.equal('name' in first,false);
  assert.equal('name' in (await call(db,'staff','admin_list_tickets',[id,1])).tickets[0],false);
  await assert.rejects(db.query('update public.tickets set guardians=5'),/以外の変更/);
  const columns=await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='tickets'");
  assert.equal(columns.rows.some(c=>c.column_name==='name'),false);
});

test('入場受付: 選んだ回の整理券を、受付開始から終了までの間に1回だけ受付する', async()=>{
  const db=await setup();
  const {id}=await op(db,{...round,maxParty:4});
  const other=(await op(db,{...round,label:'第2回'})).id;
  const issue=(roundId=id)=>call(db,'anon','issue_ticket',[roundId,kids(2),0,randomUUID(),randomUUID()]);
  const checkin=(args)=>call(db,'staff','admin_checkin',args);
  const t=(await issue()).ticket;
  assert.match(t.checkin_code,/^[0-9a-f]{32}$/);assert.notEqual(t.checkin_code,t.token);assert.equal(t.checked_in_at,null);
  const looked=(await call(db,'anon','lookup_tickets',[JSON.stringify([{id:t.id,token:t.token}])])).tickets[0];
  assert.equal(looked.checkin_code,t.checkin_code);
  const listed=(await call(db,'staff','admin_list_tickets',[id,null])).tickets[0];
  assert.equal('checkin_code' in listed,false);assert.equal('token' in listed,false);
  await assert.rejects(call(db,'anon','admin_checkin',[id,t.checkin_code,null]),/permission denied/);
  await fails(checkin([id,'not-a-code',null]),'invalid_code');
  await fails(checkin([id,'0'.repeat(32),null]),'not_found');
  await fails(checkin([other,t.checkin_code,null]),'wrong_round');
  await fails(checkin([id,null,null]),'invalid');
  await op(db,{action:'settings',eventDate:day(1)});
  await fails(checkin([id,t.checkin_code,null]),'before');
  await op(db,{action:'settings',eventDate:day(0)});
  const done=await checkin([id,t.checkin_code,null]);
  assert.equal(done.replayed,false);assert.equal(done.ticket.number,t.number);assert.ok(done.ticket.checked_in_at);assert.equal(done.ticket.cancellable,false);
  const again=await checkin([id,t.checkin_code,null]);
  assert.equal(again.replayed,true);assert.equal(again.ticket.checked_in_at,done.ticket.checked_in_at);
  await fails(call(db,'anon','cancel_ticket',[t.id,t.token]),'checked_in');
  await fails(call(db,'staff','admin_cancel',[t.id]),'password');
  const byNumber=(await issue()).ticket;
  assert.equal((await checkin([id,null,byNumber.number])).ticket.id,byNumber.id);
  await fails(checkin([id,null,99]),'not_found');
  const cancelled=(await issue()).ticket;
  await call(db,'anon','cancel_ticket',[cancelled.id,cancelled.token]);
  await fails(checkin([id,cancelled.checkin_code,null]),'cancelled');
  const state=await call(db,'staff','admin_state');
  const r=state.rounds.find(x=>x.id===id);
  assert.equal(r.checked_in_count,2);assert.equal(r.checked_in_people,4);assert.equal(r.active_count,2);
  assert.equal(state.totals.checked_in,2);assert.equal(state.totals.checked_in_people,4);
  const rows=await call(db,'staff','admin_export_tickets');
  assert.equal(rows.filter(x=>x.checked_in_at).length,2);
  await assert.rejects(db.query('update public.tickets set checked_in_at=null where checked_in_at is not null'),/以外の変更/);
  await assert.rejects(db.query("update public.tickets set checkin_code=repeat('a',32)"),/以外の変更/);
  const late=(await issue()).ticket;
  await op(db,{action:'settings',eventDate:day(-1)});
  await fails(checkin([id,late.checkin_code,null]),'finished');
  const log=await db.query("select count(*)::int as n from public.operations where action='checkin'");
  assert.equal(log.rows[0].n,2);
});

test('受付済みの取消: スタッフが7桁の取消用パスワードを入れたときだけ取り消せる', async()=>{
  const db=await setup();
  const {id}=await op(db,{...round,capacity:4});
  const t=(await call(db,'anon','issue_ticket',[id,kids(2),0,randomUUID(),randomUUID()])).ticket;
  const done=(await call(db,'staff','admin_checkin',[id,t.checkin_code,null])).ticket;
  await assert.rejects(call(db,'staff','admin_cancel',[t.id,'7654321']),e=>e.hint==='password'&&/設定されていません/.test(e.message));
  await assert.rejects(db.query("select private.set_cancel_password('12345')"),/7桁/);
  await db.query("select private.set_cancel_password('7654321')");
  const stored=await db.query("select value from private.secrets where key='cancel_password'");
  assert.match(stored.rows[0].value,/^[0-9a-f]{64}$/);
  await assert.rejects(as(db,'staff',"select private.set_cancel_password('1111111')"),/permission denied/);
  await assert.rejects(as(db,'staff',"select * from private.secrets"),/permission denied/);
  await fails(call(db,'staff','admin_cancel',[t.id]),'password');
  await fails(call(db,'staff','admin_cancel',[t.id,'1234567']),'password');
  await fails(call(db,'staff','admin_cancel',[t.id,'765432']),'password');
  await assert.rejects(call(db,'anon','admin_cancel',[t.id,'7654321']),/permission denied/);
  await fails(call(db,'anon','cancel_ticket',[t.id,t.token]),'checked_in');
  const res=await call(db,'staff','admin_cancel',[t.id,'7654321']);
  assert.equal(res.replayed,false);assert.equal(res.ticket.status,'cancelled');assert.equal(res.ticket.cancelled_by,'staff');
  assert.equal(res.ticket.checked_in_at,done.checked_in_at);
  assert.equal((await call(db,'staff','admin_cancel',[t.id,'7654321'])).replayed,true);
  const r=(await call(db,'staff','admin_state')).rounds.find(x=>x.id===id);
  assert.equal(r.checked_in_count,0);assert.equal(r.active_count,0);assert.equal(r.remaining,4);
  await fails(call(db,'staff','admin_checkin',[id,t.checkin_code,null]),'cancelled');
  const visitor=(await call(db,'anon','lookup_tickets',[JSON.stringify([{id:t.id,token:t.token}])])).tickets[0];
  assert.equal(visitor.status,'cancelled');assert.equal(visitor.cancelled_by,'staff');
  await assert.rejects(db.query("update public.tickets set status='active', cancelled_at=null, cancelled_by=null"),/以外の変更/);
  const log=await db.query("select details from public.operations where action='staff_cancel'");
  assert.equal(log.rows[0].details.checked_in,true);
});

test('取消: 本人は開演前だけ、スタッフはいつでも。取消番号は再利用しない', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  const device=randomUUID();
  const t=(await call(db,'anon','issue_ticket',[id,kids(2),0,device,randomUUID()])).ticket;
  await fails(call(db,'anon','cancel_ticket',[t.id,'wrong']),'forbidden');
  const done=await call(db,'anon','cancel_ticket',[t.id,t.token]);
  assert.equal(done.ticket.status,'cancelled');assert.equal(done.ticket.cancelled_by,'visitor');
  assert.equal((await call(db,'anon','cancel_ticket',[t.id,t.token])).replayed,true);
  const next=(await call(db,'anon','issue_ticket',[id,kids(2),0,device,randomUUID()])).ticket;
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

test('整理券の一覧: 回を指定しないと、すべての回の整理券を新しい順に返す', async()=>{
  const db=await setup();
  await db.exec("insert into public.events(label, venue) values ('ダンス', '中庭')");
  const a=(await op(db,round)).id,b=(await op(db,{...round,eventId:2,label:'第2回',startsTime:'23:58'})).id;
  const issue=rid=>call(db,'anon','issue_ticket',[rid,kids(1),0,randomUUID(),randomUUID()]);
  await issue(a);await issue(b);await issue(a);
  const all=(await call(db,'staff','admin_list_tickets',[null,null])).tickets;
  assert.deepEqual(all.map(t=>[t.event_label,t.round_label,t.number]),[['ステージ','第1回',2],['ダンス','第2回',1],['ステージ','第1回',1]]);
  assert.ok(all.every(t=>t.device));
  const ones=(await call(db,'staff','admin_list_tickets',[null,1])).tickets;
  assert.deepEqual(ones.map(t=>t.round_id).sort(),[a,b].sort());
  assert.equal((await call(db,'staff','admin_list_tickets',[null,9])).tickets.length,0);
  assert.equal((await call(db,'staff','admin_list_tickets',[b,null])).tickets.length,1);
  await fails(call(db,'staff','admin_list_tickets',[999,null]),'not_found');
  await assert.rejects(call(db,'anon','admin_list_tickets',[null,null]),/permission denied/);
});

test('運営操作の検証と記録の保護', async()=>{
  const db=await setup();
  const {id}=await op(db,round);
  await call(db,'anon','issue_ticket',[id,kids(4),0,randomUUID(),randomUUID()]);
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
  await assert.rejects(db.query("update public.tickets set party_size=1"),/以外の変更/);
  await assert.rejects(db.query('delete from public.operations'),/変更・削除できません/);
  const log=await db.query('select action, actor from public.operations order by id');
  assert.deepEqual(log.rows.map(r=>r.action),['create','create','delete']);
  assert.equal(log.rows[0].actor,STAFF);
});

test('イベント: 作成・変更・削除と、回はイベントに属する', async()=>{
  const db=await setup();
  const ev=await op(db,{action:'event_create',label:'ダンス',venue:'中庭',notice:'雨天時は体育館'});
  await fails(op(db,{action:'event_create',label:''}),'invalid');
  await op(db,{action:'event_update',id:ev.id,label:'ダンス部',venue:'中庭',notice:''});
  await fails(op(db,{...round,eventId:999}),'invalid');
  await fails(op(db,{...round,eventId:undefined}),'invalid');
  await fails(op(db,{...round,durationMinutes:0}),'invalid');
  const {id}=await op(db,{...round,eventId:ev.id,startsTime:'23:00',durationMinutes:45});
  const s=await call(db,'anon','public_state');
  assert.deepEqual(s.events.map(e=>e.label),['ステージ','ダンス部']);
  assert.equal(s.events[1].venue,'中庭');
  const r=s.rounds[0];
  assert.equal(r.event_id,ev.id);assert.equal(r.duration_minutes,45);assert.equal(r.ends_time,'23:45');
  assert.equal(r.waiting_count,0);assert.equal(r.waitlist_open,false);
  await fails(op(db,{action:'event_delete',id:ev.id}),'invalid');
  await op(db,{action:'delete',id});
  await op(db,{action:'event_delete',id:ev.id});
  assert.equal((await call(db,'anon','public_state')).events.length,1);
  const t=(await call(db,'anon','issue_ticket',[(await op(db,round)).id,kids(1),0,randomUUID(),randomUUID()])).ticket;
  assert.equal(t.event_label,'ステージ');assert.equal(t.venue,'体育館');
});

test('イベントの対象: 対象外の区分の子どもでは整理券もキャンセル待ちも取れない', async()=>{
  const db=await setup();
  const all=['preschool','elementary','junior_high','high_school'];
  assert.deepEqual((await call(db,'anon','public_state')).events[0].kinds,all);
  await fails(op(db,{action:'event_create',label:'空',kinds:[]}),'invalid');
  await fails(op(db,{action:'event_create',label:'空',kinds:['adult']}),'invalid');
  const ev=await op(db,{action:'event_create',label:'ボルダリング',kinds:['junior_high','high_school']});
  const kindsOf=async()=>(await call(db,'anon','public_state')).events.find(e=>e.id===ev.id).kinds;
  assert.deepEqual(await kindsOf(),['junior_high','high_school']);
  const id=(await op(db,{...late,eventId:ev.id,startsTime:'23:00',capacity:2,maxParty:2})).id;
  const mixed=JSON.stringify({elementary:1,high_school:1});
  await fails(call(db,'anon','issue_ticket',[id,mixed,1,randomUUID(),randomUUID()]),'kinds');
  await assert.rejects(call(db,'anon','issue_ticket',[id,mixed,1,randomUUID(),randomUUID()]),/小学生/);
  const device=randomUUID(),request=randomUUID();
  await call(db,'anon','issue_ticket',[id,kids(2),0,device,request]);
  assert.equal((await call(db,'anon','issue_ticket',[id,kids(2),0,device,request])).replayed,true);
  await fails(call(db,'anon','join_waitlist',[id,mixed,1,randomUUID(),randomUUID()]),'kinds');
  await call(db,'anon','join_waitlist',[id,kids(1),0,randomUUID(),randomUUID()]);
  await op(db,{action:'event_update',id:ev.id,label:'ボルダリング',venue:'',notice:''});
  assert.deepEqual(await kindsOf(),['junior_high','high_school']);
  await op(db,{action:'event_update',id:ev.id,label:'ボルダリング',venue:'',notice:'',kinds:['elementary']});
  assert.deepEqual(await kindsOf(),['elementary']);
  await assert.rejects(call(db,'anon','admin_operation_base',[JSON.stringify({action:'event_delete',id:ev.id})]),/does not exist|permission denied/);
});

test('時間の重なり: 開演〜終演が重なる回の整理券は同じ端末で持てない', async()=>{
  const db=await setup();
  const a=(await op(db,{...late,label:'A',startsTime:'23:00',durationMinutes:20})).id;
  const b=(await op(db,{...late,label:'B',startsTime:'23:10',durationMinutes:10})).id;
  const c=(await op(db,{...late,label:'C',startsTime:'23:20',durationMinutes:10})).id;
  const device=randomUUID();
  const issue=(id,d=device)=>call(db,'anon','issue_ticket',[id,kids(1),0,d,randomUUID()]);
  const t=(await issue(a)).ticket;
  await fails(issue(b),'overlap');
  await assert.rejects(issue(b),/A/);
  await issue(c);
  await issue(b,randomUUID());
  await call(db,'anon','cancel_ticket',[t.id,t.token]);
  await issue(b);
});

test('キャンセル待ち: 満員なら登録でき、空きが出ると入れる人から登録順に繰り上がる', async()=>{
  const db=await setup();
  const id=(await op(db,{...late,startsTime:'23:00',capacity:4,maxParty:4})).id;
  const [d1,d2,d3,d4,d5]=Array.from({length:5},()=>randomUUID());
  const issue=(d,n=1)=>call(db,'anon','issue_ticket',[id,kids(n),0,d,randomUUID()]);
  const join=(d,n=1,request=randomUUID(),roundId=id)=>call(db,'anon','join_waitlist',[roundId,kids(n),0,d,request]);
  const pub=async()=>(await call(db,'anon','public_state')).rounds.find(r=>r.id===id);
  await fails(join(d2),'open');
  const t1=(await issue(d1,4)).ticket;
  assert.equal((await pub()).waitlist_open,true);
  await fails(join(d1),'already');
  const request=randomUUID();
  const w2=(await join(d2,2,request)).entry;
  assert.equal(w2.status,'waiting');assert.equal(w2.position,1);assert.ok(w2.token);
  assert.equal((await join(d2,2,request)).replayed,true);
  await fails(join(randomUUID(),2,request),'request_conflict');
  await fails(join(d2),'already_waiting');
  await fails(join(d5,5),'party');
  const w3=(await join(d3,3)).entry;
  const w4=(await join(d4,1)).entry;
  assert.equal(w4.position,3);
  let p=await pub();
  assert.equal(p.waiting_count,3);assert.equal(p.status,'full');assert.equal(p.remaining,0);

  await call(db,'anon','cancel_ticket',[t1.id,t1.token]);
  const look=async(w)=>(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:w.id,token:w.token}])])).entries[0];
  const got2=await look(w2);
  assert.equal(got2.status,'promoted');assert.equal(got2.ticket.number,2);assert.ok(got2.ticket.token);assert.ok(got2.ticket.checkin_code);
  assert.equal((await look(w3)).position,1);
  const got4=await look(w4);
  assert.equal(got4.status,'promoted');assert.equal(got4.ticket.number,3);
  p=await pub();
  assert.equal(p.status,'open');assert.equal(p.remaining,1);assert.equal(p.waiting_count,1);assert.equal(p.waitlist_open,true);
  assert.equal((await issue(d5)).ticket.number,4);
  p=await pub();
  assert.equal(p.status,'full');assert.equal(p.remaining,0);
  await fails(issue(randomUUID()),'full');
  const admin=(await call(db,'staff','admin_state')).rounds.find(r=>r.id===id);
  assert.equal(admin.remaining,0);assert.equal(admin.waiting_count,1);assert.equal(admin.waiting_people,3);assert.equal(admin.promoted_count,2);

  await fails(call(db,'anon','leave_waitlist',[w3.id,'wrong']),'forbidden');
  const left=await call(db,'anon','leave_waitlist',[w3.id,w3.token]);
  assert.equal(left.entry.status,'cancelled');
  assert.equal((await call(db,'anon','leave_waitlist',[w3.id,w3.token])).replayed,true);
  p=await pub();
  assert.equal(p.status,'full');assert.equal(p.waiting_count,0);

  const list=(await call(db,'staff','admin_list_waitlist',[id])).entries;
  assert.deepEqual(list.map(x=>x.status),['promoted','cancelled','promoted']);
  assert.equal(list[0].ticket_number,2);assert.equal('token' in list[0],false);
  const state=await call(db,'staff','admin_state');
  assert.equal(state.totals.promoted,2);assert.equal(state.totals.waiting,0);
  const rows=await call(db,'staff','admin_export_tickets');
  assert.equal(rows.filter(r=>r.via_waitlist).length,2);assert.equal(rows[0].event_label,'ステージ');
  await assert.rejects(db.query("update public.waitlist set status='waiting'"),/状態の変更/);
  await assert.rejects(db.query('delete from public.waitlist'),/削除できません/);
  const log=await db.query("select count(*)::int as n from public.operations where action='promote'");
  assert.equal(log.rows[0].n,2);
});

test('キャンセル待ち: 先頭が入れなければ後ろの入れる人が先に繰り上がる・定員を増やすと繰り上がる・受付停止', async()=>{
  const db=await setup();
  const id=(await op(db,{...late,startsTime:'23:00',capacity:4,maxParty:4})).id;
  const issue=(d,n)=>call(db,'anon','issue_ticket',[id,kids(n),0,d,randomUUID()]);
  const join=(d,n)=>call(db,'anon','join_waitlist',[id,kids(n),0,d,randomUUID()]);
  const a=(await issue(randomUUID(),1)).ticket;
  await issue(randomUUID(),3);
  const head=(await join(randomUUID(),3)).entry;
  const small=(await join(randomUUID(),1)).entry;
  await call(db,'anon','cancel_ticket',[a.id,a.token]);
  const look=async(w)=>(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:w.id,token:w.token}])])).entries[0];
  assert.equal((await look(head)).status,'waiting');
  assert.equal((await look(small)).status,'promoted');
  assert.equal((await look(head)).position,1);
  await op(db,{...late,action:'update',id,startsTime:'23:00',capacity:7,maxParty:4});
  assert.equal((await look(head)).status,'promoted');
  await op(db,{action:'waitlist_off',id});
  const pub=(await call(db,'anon','public_state')).rounds[0];
  assert.equal(pub.waitlist_open,false);
  await fails(join(randomUUID(),1),'waitlist_off');
  await op(db,{action:'waitlist_on',id});
  await join(randomUUID(),1);
  await op(db,{action:'settings',eventDate:day(-1)});
  const after=(await call(db,'staff','admin_list_waitlist',[id])).entries;
  assert.equal(after.at(-1).status,'expired');
  assert.equal((await call(db,'staff','admin_state')).rounds[0].waiting_count,0);
});

test('キャンセル待ち: 残りより多い人数なら、空きがあっても登録できる。空きに入る人は整理券を取れる', async()=>{
  const db=await setup();
  const id=(await op(db,{...late,startsTime:'23:00',capacity:4,maxParty:4})).id;
  const issue=(d,n)=>call(db,'anon','issue_ticket',[id,kids(n),0,d,randomUUID()]);
  const join=(d,n)=>call(db,'anon','join_waitlist',[id,kids(n),0,d,randomUUID()]);
  const pub=async()=>(await call(db,'anon','public_state')).rounds.find(r=>r.id===id);
  await issue(randomUUID(),2);
  assert.equal((await pub()).waitlist_open,true);
  await fails(join(randomUUID(),2),'open');
  await fails(issue(randomUUID(),3),'remaining');
  const big=(await join(randomUUID(),3)).entry;
  assert.equal(big.status,'waiting');assert.equal(big.position,1);
  let p=await pub();
  assert.equal(p.status,'open');assert.equal(p.remaining,2);assert.equal(p.waiting_count,1);
  const t=(await issue(randomUUID(),2)).ticket;
  p=await pub();
  assert.equal(p.status,'full');assert.equal(p.remaining,0);
  await call(db,'anon','cancel_ticket',[t.id,t.token]);
  const look=(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:big.id,token:big.token}])])).entries[0];
  assert.equal(look.status,'waiting');
  await op(db,{...late,action:'update',id,startsTime:'23:00',capacity:5,maxParty:4});
  const after=(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:big.id,token:big.token}])])).entries[0];
  assert.equal(after.status,'promoted');
  await op(db,{...late,action:'update',id,startsTime:'23:00',capacity:9,maxParty:4});
  assert.equal((await pub()).waitlist_open,false);
});

test('キャンセル待ち: 時間が重なる整理券があると登録できず、繰り上がると重なる待ちは外れる', async()=>{
  const db=await setup();
  const x=(await op(db,{...late,label:'X',startsTime:'23:00',durationMinutes:30,capacity:1,maxParty:1})).id;
  const y=(await op(db,{...late,label:'Y',startsTime:'23:15',durationMinutes:30,capacity:1,maxParty:1})).id;
  const z=(await op(db,{...late,label:'Z',startsTime:'23:15',durationMinutes:30,capacity:5,maxParty:1})).id;
  const issue=(id,d)=>call(db,'anon','issue_ticket',[id,kids(1),0,d,randomUUID()]);
  const join=(id,d)=>call(db,'anon','join_waitlist',[id,kids(1),0,d,randomUUID()]);
  const tx=(await issue(x,randomUUID())).ticket;
  await issue(y,randomUUID());
  const me=randomUUID();
  const wx=(await join(x,me)).entry;
  const wy=(await join(y,me)).entry;
  await call(db,'anon','cancel_ticket',[tx.id,tx.token]);
  const look=async(w)=>(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:w.id,token:w.token}])])).entries[0];
  assert.equal((await look(wx)).status,'promoted');
  assert.equal((await look(wy)).status,'removed');
  await fails(join(y,me),'overlap');
  const other=randomUUID();
  const wy2=(await join(y,other)).entry;
  await fails(issue(z,other),'wait_overlap');
  await assert.rejects(issue(z,other),/Y.*キャンセル待ちをしているため/);
  assert.equal((await look(wy2)).status,'waiting');
  await call(db,'anon','leave_waitlist',[wy2.id,wy2.token]);
  assert.equal((await issue(z,other)).ticket.round_id,z);
});

test('キャンセル待ち中は、時間が重なる回の整理券を取れない（重ならない回は取れる）', async()=>{
  const db=await setup();
  const y=(await op(db,{...late,label:'Y',startsTime:'23:15',durationMinutes:30,capacity:1,maxParty:1})).id;
  const z=(await op(db,{...late,label:'Z',startsTime:'23:30',durationMinutes:20,capacity:5,maxParty:1})).id;
  const far=(await op(db,{...late,label:'F',startsTime:'22:00',durationMinutes:30,capacity:5,maxParty:1})).id;
  const issue=(id,d)=>call(db,'anon','issue_ticket',[id,kids(1),0,d,randomUUID()]);
  await issue(y,randomUUID());
  const me=randomUUID();
  const w=(await call(db,'anon','join_waitlist',[y,kids(1),0,me,randomUUID()])).entry;
  await fails(issue(z,me),'wait_overlap');
  assert.equal((await issue(far,me)).ticket.round_id,far);
  const look=(await call(db,'anon','lookup_waitlist',[JSON.stringify([{id:w.id,token:w.token}])])).entries[0];
  assert.equal(look.status,'waiting');
});
