// 本物の Supabase プロジェクトに対する動作確認（発行・再送・1端末1枚・取消・定員・200件同時・入場受付）。
// 使い方（source フォルダーで）:
//   set SEIRIKEN_STAFF_EMAIL=staff@example.com
//   set SEIRIKEN_STAFF_PASSWORD=パスワード
//   ..\runtime\node.exe tests\online-smoke.mjs
// 「自動確認」という名前の回を1つ作り、最後に一時停止します（整理券を発行した回は削除できないため残ります）。
// 本番のデータを登録する前、または確認用に別のプロジェクトを作って実行してください。
import {readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const envFile=new URL('../.env.online',import.meta.url);
if(!existsSync(envFile)){console.error('source/.env.online がありません。');process.exit(1);}
const env=Object.fromEntries(readFileSync(envFile,'utf8').split(/\r?\n/).filter(l=>/^\s*VITE_\w+\s*=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const URL_=env.VITE_SUPABASE_URL?.replace(/\/$/,''),KEY=env.VITE_SUPABASE_ANON_KEY;
const EMAIL=process.env.SEIRIKEN_STAFF_EMAIL,PASSWORD=process.env.SEIRIKEN_STAFF_PASSWORD;
if(!URL_||!KEY){console.error('source/.env.online に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を書いてください。');process.exit(1);}
if(!EMAIL||!PASSWORD){console.error('SEIRIKEN_STAFF_EMAIL と SEIRIKEN_STAFF_PASSWORD に運営スタッフのログイン情報を設定してください。');process.exit(1);}

async function request(path,body,token){
  const res=await fetch(URL_+path,{method:'POST',headers:{apikey:KEY,Authorization:`Bearer ${token??KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body??{})});
  const data=await res.json().catch(()=>null);
  if(!res.ok){const e=new Error(data?.message||data?.msg||data?.error_description||`HTTP ${res.status}`);e.hint=data?.hint;e.status=res.status;throw e;}
  return data;
}
const rpc=(fn,args,token)=>request(`/rest/v1/rpc/${fn}`,args,token);
async function fails(promise,code){
  try{await promise;}catch(e){assert.equal(e.hint,code,`${code} を期待しましたが ${e.hint}（${e.message}）でした`);return;}
  assert.fail(`${code} で断られるはずが、成功しました`);
}
const step=(name)=>console.log('✔ '+name);

const login=await request('/auth/v1/token?grant_type=password',{email:EMAIL,password:PASSWORD});
const staff=login.access_token;
step('スタッフでログイン');

const anonAdmin=await rpc('admin_state',{}).then(()=>'ok',e=>e.status);
assert.notEqual(anonAdmin,'ok','ログインしていない人が運営データを読めてしまいます');
const tableRead=await fetch(`${URL_}/rest/v1/tickets?select=*`,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`}});
assert.notEqual(tableRead.status,200,'来場者が tickets 表を直接読めてしまいます');
step('ログインしていない人は運営データも表も読めない');
const signup=await fetch(`${URL_}/auth/v1/signup`,{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({email:`probe-${randomUUID()}@example.com`,password:randomUUID()})});
assert.notEqual(signup.status,200,'誰でもアカウントを作れる設定（Allow new users to sign up）が有効です。ログインできる人は全員スタッフ扱いになるため、無効にしてください');
step('新規登録（Sign up）が無効になっている');

const state=await rpc('admin_state',{},staff);
if(state.eventDate!==state.today){console.error(`開催日（${state.eventDate}）が今日（${state.today}）ではないため、受付中の回を作れません。運営画面で開催日を今日にしてから実行してください。`);process.exit(1);}
const capacity=60;
const {id}=await rpc('admin_operation',{p:{action:'create',label:'自動確認',startsTime:'23:59',opensTime:'00:00',closesTime:'23:59',capacity,maxParty:4,finishAfterMinutes:0}},staff);
step(`確認用の回を作成（id ${id}）`);

try{
  const issue=(party,device=randomUUID(),req=randomUUID())=>rpc('issue_ticket',{p_round_id:id,p_children:{high_school:party},p_guardians:0,p_device_id:device,p_request_id:req});
  const device=randomUUID(),req=randomUUID();
  const first=await issue(2,device,req);
  assert.equal(first.ticket.number,1);
  const replay=await issue(2,device,req);
  assert.equal(replay.replayed,true);assert.equal(replay.ticket.id,first.ticket.id);
  step('発行と、同じ送信の再送（同じ整理券が返る）');
  await fails(issue(1,device),'already');
  await fails(issue(5),'party');
  step('1端末1枚・1枚あたりの人数上限');
  const cancelled=await rpc('cancel_ticket',{p_id:first.ticket.id,p_token:first.ticket.token});
  assert.equal(cancelled.ticket.status,'cancelled');
  await fails(rpc('cancel_ticket',{p_id:first.ticket.id,p_token:'wrong'}),'forbidden');
  const second=await issue(1,device);
  assert.equal(second.ticket.number,2);
  step('取消（取消した番号は再利用しない）');

  const before=(await rpc('public_state',{})).rounds.find(r=>r.id===id).remaining;
  const started=Date.now();
  const results=await Promise.allSettled(Array.from({length:200},()=>issue(1)));
  const ok=results.filter(r=>r.status==='fulfilled').map(r=>r.value.ticket.number);
  const reasons=new Set(results.filter(r=>r.status==='rejected').map(r=>r.reason.hint||r.reason.message));
  assert.equal(ok.length,before,`残り ${before} 名に対して ${ok.length} 枚発行されました`);
  assert.equal(new Set(ok).size,ok.length,'番号が重複しています');
  assert.ok([...reasons].every(r=>r==='full'||r==='remaining'),`想定外の失敗: ${[...reasons].join(', ')}`);
  const after=(await rpc('public_state',{})).rounds.find(r=>r.id===id);
  assert.equal(after.remaining,0);assert.equal(after.status,'full');
  step(`200件同時の申し込み: ${ok.length} 件発行・残りは断り、番号の重複なし（${Date.now()-started} ms）`);

  const list=await rpc('admin_list_tickets',{p_round_id:id,p_number:null},staff);
  assert.equal(list.tickets.filter(t=>t.status==='active').length,ok.length+1);
  await rpc('admin_cancel',{p_id:second.ticket.id},staff);
  step('スタッフの一覧・取消');

  const entering=results.find(r=>r.status==='fulfilled').value.ticket;
  const anonCheckin=await rpc('admin_checkin',{p_round_id:id,p_code:entering.checkin_code,p_number:null}).then(()=>'ok',e=>e.status);
  assert.notEqual(anonCheckin,'ok','ログインしていない人が入場受付できてしまいます');
  const done=await rpc('admin_checkin',{p_round_id:id,p_code:entering.checkin_code,p_number:null},staff);
  assert.equal(done.replayed,false);assert.ok(done.ticket.checked_in_at);
  assert.equal((await rpc('admin_checkin',{p_round_id:id,p_code:entering.checkin_code,p_number:null},staff)).replayed,true);
  await fails(rpc('admin_cancel',{p_id:entering.id},staff),'checked_in');
  step('入場受付（2回目は「受付済み」、受付済みは取り消せない）');
}finally{
  await rpc('admin_operation',{p:{action:'pause',id}},staff).catch(()=>{});
  console.log(`確認用の回「自動確認」（id ${id}）は一時停止にしました。不要なら、本番前にプロジェクトを作り直すか、そのままにしておいてください。`);
}
console.log('すべての確認が終わりました。');
