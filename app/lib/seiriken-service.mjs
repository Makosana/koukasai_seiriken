import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';

export class SeirikenError extends Error{
  constructor(message,status=400,code='invalid'){super(message);this.status=status;this.code=code;}
}

const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
const DATE=/^(\d{4})-(\d{2})-(\d{2})$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUS_LABELS={before:'受付前',open:'受付中',full:'満員',paused:'一時停止中',closed:'受付終了',finished:'終了した回'};
const LIMITS={capacity:10000,party:20,finish:600,label:40,guardians:10};
export const CHILD_KINDS=[['preschool','未就学児'],['elementary','小学生'],['junior_high','中学生'],['high_school','高校生']];
const WITH_GUARDIAN=['preschool','elementary'];

function partyInput(body){
  const raw=body?.children;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new SeirikenError('人数を選んでください。');
  const children={};
  for(const [key,name] of CHILD_KINDS)children[key]=int(raw[key]??0,0,LIMITS.party,`${name}の人数`);
  const total=CHILD_KINDS.reduce((s,[key])=>s+children[key],0);
  if(total<1)throw new SeirikenError('子どもの人数を1名以上選んでください。');
  const needsGuardian=WITH_GUARDIAN.some(key=>children[key]>0);
  const guardians=needsGuardian?int(body?.guardians??0,0,LIMITS.guardians,'保護者の人数'):0;
  return {children,total,guardians};
}
const childrenOf=t=>({preschool:t.preschool??0,elementary:t.elementary??0,junior_high:t.junior_high??0,high_school:t.high_school??0});

export function jstDate(now){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function jstTime(iso){
  return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso));
}
function at(date,time){return new Date(`${date}T${time}:00+09:00`);}
function validDate(value){
  const m=DATE.exec(String(value??''));if(!m)return false;
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3];
}
function int(value,min,max,label){
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new SeirikenError(`${label}は${min}〜${max}の整数で入力してください。`);
  return value;
}
function uuid(value,label){if(typeof value!=='string'||!UUID.test(value))throw new SeirikenError(`${label}を確認できません。画面を再読み込みしてください。`);return value.toLowerCase();}
function same(a,b){const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);}

export function ensureSettings(sqlite,now){
  sqlite.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('event_date',jstDate(now));
}
export function eventDate(sqlite){return sqlite.prepare("SELECT value FROM settings WHERE key='event_date'").get().value;}
function record(sqlite,now,action,details){
  sqlite.prepare('INSERT INTO operations(created_at,action,details) VALUES(?,?,?)').run(now.toISOString(),action,JSON.stringify(details));
}

const ROUND_STATS=`SELECT r.*,
  COALESCE(SUM(CASE WHEN t.status='active' THEN t.party_size END),0) AS used_people,
  COUNT(CASE WHEN t.status='active' THEN 1 END) AS active_count,
  COUNT(CASE WHEN t.status='cancelled' THEN 1 END) AS cancelled_count,
  COALESCE(SUM(CASE WHEN t.status='cancelled' THEN t.party_size END),0) AS cancelled_people,
  COALESCE(MAX(t.number),0) AS last_number,
  COALESCE(SUM(CASE WHEN t.status='active' THEN t.guardians END),0) AS used_guardians
FROM rounds r LEFT JOIN tickets t ON t.round_id=r.id`;

function roundTimes(row,date){
  const starts=at(date,row.starts_time),opens=at(date,row.opens_time),closes=at(date,row.closes_time);
  const finishes=new Date(starts.getTime()+row.finish_after_minutes*60000);
  return {starts,opens,closes,finishes};
}
function statusOf(row,times,remaining,now){
  const t=now.getTime();
  if(t>=times.finishes.getTime())return 'finished';
  if(t>=times.closes.getTime())return 'closed';
  if(t<times.opens.getTime())return 'before';
  if(row.paused)return 'paused';
  if(remaining<1)return 'full';
  return 'open';
}
function roundView(row,date,now){
  const times=roundTimes(row,date),remaining=Math.max(0,row.capacity_people-row.used_people);
  return {
    id:row.id,label:row.label,starts_time:row.starts_time,opens_time:row.opens_time,closes_time:row.closes_time,
    starts_at:times.starts.toISOString(),opens_at:times.opens.toISOString(),closes_at:times.closes.toISOString(),finishes_at:times.finishes.toISOString(),
    capacity_people:row.capacity_people,max_party:row.max_party,remaining,status:statusOf(row,times,remaining,now)
  };
}
function adminRoundView(row,date,now){
  return {...roundView(row,date,now),finish_after_minutes:row.finish_after_minutes,paused:!!row.paused,used_people:row.used_people,active_count:row.active_count,cancelled_count:row.cancelled_count,cancelled_people:row.cancelled_people,last_number:row.last_number,used_guardians:row.used_guardians};
}
function roundRow(sqlite,id){return sqlite.prepare(ROUND_STATS+' WHERE r.id=? GROUP BY r.id').get(id);}
function allRounds(sqlite){return sqlite.prepare(ROUND_STATS+' GROUP BY r.id ORDER BY r.starts_time, r.id').all();}

function ticketView(t,round,date,now,withToken){
  const times=roundTimes(round,date);
  return {
    id:t.id,...(withToken?{token:t.cancel_token}:{}),round_id:t.round_id,round_label:round.label,starts_time:round.starts_time,starts_at:times.starts.toISOString(),
    number:t.number,party_size:t.party_size,children:childrenOf(t),guardians:t.guardians??0,status:t.status,created_at:t.created_at,cancelled_at:t.cancelled_at,cancelled_by:t.cancelled_by,
    cancellable:t.status==='active'&&now.getTime()<times.starts.getTime(),round_finished:now.getTime()>=times.finishes.getTime()
  };
}
function ticketWithRound(sqlite,id){
  const t=sqlite.prepare('SELECT * FROM tickets WHERE id=?').get(id);if(!t)return null;
  return {t,round:sqlite.prepare('SELECT * FROM rounds WHERE id=?').get(t.round_id)};
}

export function publicState(sqlite,now){
  const date=eventDate(sqlite);
  return {now:now.toISOString(),eventDate:date,rounds:allRounds(sqlite).map(r=>roundView(r,date,now))};
}

export function issueTicket(storage,body,now){
  const roundId=int(body?.roundId,1,Number.MAX_SAFE_INTEGER,'回');
  const party=partyInput(body),partySize=party.total;
  const deviceId=uuid(body?.deviceId,'端末の識別番号'),requestId=uuid(body?.requestId,'送信番号');
  const {sqlite}=storage;
  return storage.transaction(()=>{
    const date=eventDate(sqlite);
    const existing=sqlite.prepare('SELECT * FROM tickets WHERE request_id=?').get(requestId);
    if(existing){
      if(existing.device_id!==deviceId)throw new SeirikenError('送信番号が重複しています。画面を再読み込みしてください。',409,'request_conflict');
      const round=sqlite.prepare('SELECT * FROM rounds WHERE id=?').get(existing.round_id);
      return {ticket:ticketView(existing,round,date,now,true),replayed:true};
    }
    const row=roundRow(sqlite,roundId);
    if(!row)throw new SeirikenError('この回は見つかりません。画面を再読み込みしてください。',404,'not_found');
    const round=roundView(row,date,now);
    if(round.status==='before')throw new SeirikenError(`まだ受付前です。${row.opens_time} から受け付けます。`,409,'before');
    if(round.status==='paused')throw new SeirikenError('現在、この回の受付を一時停止しています。しばらくしてからお試しください。',409,'paused');
    if(round.status==='closed'||round.status==='finished')throw new SeirikenError('この回の受付は終了しました。',409,'closed');
    if(round.status==='full')throw new SeirikenError('この回は満員になりました。',409,'full');
    if(partySize>row.max_party)throw new SeirikenError(`1枚で申し込めるのは、子ども ${row.max_party} 名までです。`,400,'party');
    if(partySize>round.remaining)throw new SeirikenError(`残りは子ども ${round.remaining} 名分です。人数を減らしてください。`,409,'remaining');
    if(sqlite.prepare("SELECT 1 FROM tickets WHERE round_id=? AND device_id=? AND status='active'").get(roundId,deviceId))throw new SeirikenError('この回の整理券はすでにお持ちです。「整理券を見る」から確認してください。',409,'already');
    const number=sqlite.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM tickets WHERE round_id=?').get(roundId).n;
    const ticket={id:randomUUID(),round_id:roundId,number,party_size:partySize,...party.children,guardians:party.guardians,device_id:deviceId,request_id:requestId,cancel_token:randomBytes(24).toString('base64url'),status:'active',created_at:now.toISOString(),cancelled_at:null,cancelled_by:null};
    sqlite.prepare('INSERT INTO tickets(id,round_id,number,party_size,preschool,elementary,junior_high,high_school,guardians,device_id,request_id,cancel_token,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ticket.id,ticket.round_id,ticket.number,ticket.party_size,ticket.preschool,ticket.elementary,ticket.junior_high,ticket.high_school,ticket.guardians,ticket.device_id,ticket.request_id,ticket.cancel_token,ticket.status,ticket.created_at);
    return {ticket:ticketView(ticket,row,date,now,true),replayed:false};
  });
}

export function findRequest(sqlite,body,now){
  const requestId=uuid(body?.requestId,'送信番号'),deviceId=uuid(body?.deviceId,'端末の識別番号');
  const t=sqlite.prepare('SELECT * FROM tickets WHERE request_id=?').get(requestId);
  if(!t||t.device_id!==deviceId)return {ticket:null};
  return {ticket:ticketView(t,sqlite.prepare('SELECT * FROM rounds WHERE id=?').get(t.round_id),eventDate(sqlite),now,true)};
}

export function lookupTickets(sqlite,body,now){
  const items=Array.isArray(body?.items)?body.items:null;
  if(!items||items.length>30)throw new SeirikenError('整理券の情報を読み取れません。');
  const date=eventDate(sqlite);
  const tickets=items.map(item=>{
    if(typeof item?.id!=='string'||typeof item?.token!=='string'||!UUID.test(item.id))return null;
    const found=ticketWithRound(sqlite,item.id.toLowerCase());
    if(!found||!same(found.t.cancel_token,item.token))return null;
    return ticketView(found.t,found.round,date,now,true);
  });
  return {now:now.toISOString(),tickets};
}

export function cancelByVisitor(storage,body,now){
  const id=uuid(body?.id,'整理券');
  if(typeof body?.token!=='string')throw new SeirikenError('整理券を確認できません。',403,'forbidden');
  const {sqlite}=storage;
  return storage.transaction(()=>{
    const found=ticketWithRound(sqlite,id);
    if(!found||!same(found.t.cancel_token,body.token))throw new SeirikenError('整理券を確認できません。',403,'forbidden');
    const date=eventDate(sqlite);
    if(found.t.status==='cancelled')return {ticket:ticketView(found.t,found.round,date,now,true),replayed:true};
    if(now.getTime()>=roundTimes(found.round,date).starts.getTime())throw new SeirikenError('開演時刻を過ぎたため、この整理券は取り消せません。',409,'started');
    sqlite.prepare("UPDATE tickets SET status='cancelled',cancelled_at=?,cancelled_by='visitor' WHERE id=?").run(now.toISOString(),id);
    return {ticket:ticketView(sqlite.prepare('SELECT * FROM tickets WHERE id=?').get(id),found.round,date,now,true),replayed:false};
  });
}

export function cancelByStaff(storage,body,now){
  const id=uuid(body?.id,'整理券');
  const {sqlite}=storage;
  return storage.transaction(()=>{
    const found=ticketWithRound(sqlite,id);
    if(!found)throw new SeirikenError('整理券が見つかりません。',404,'not_found');
    const date=eventDate(sqlite);
    if(found.t.status==='cancelled')return {ticket:adminTicketView(found.t,found.round,date,now),replayed:true};
    sqlite.prepare("UPDATE tickets SET status='cancelled',cancelled_at=?,cancelled_by='staff' WHERE id=?").run(now.toISOString(),id);
    record(sqlite,now,'staff_cancel',{ticket:id,round:found.round.id,number:found.t.number});
    return {ticket:adminTicketView(sqlite.prepare('SELECT * FROM tickets WHERE id=?').get(id),found.round,date,now),replayed:false};
  });
}

function adminTicketView(t,round,date,now){
  return {...ticketView(t,round,date,now,false),device:t.device_id.slice(0,8)};
}

export function adminState(sqlite,now){
  const date=eventDate(sqlite);
  const rounds=allRounds(sqlite).map(r=>adminRoundView(r,date,now));
  const totals=rounds.reduce((s,r)=>({tickets:s.tickets+r.active_count,people:s.people+r.used_people,guardians:s.guardians+r.used_guardians,cancelled:s.cancelled+r.cancelled_count,capacity:s.capacity+r.capacity_people,remaining:s.remaining+r.remaining}),{tickets:0,people:0,guardians:0,cancelled:0,capacity:0,remaining:0});
  return {now:now.toISOString(),eventDate:date,today:jstDate(now),rounds,totals};
}

function roundInput(body){
  const label=String(body?.label??'').trim();
  if(!label||label.length>LIMITS.label)throw new SeirikenError(`回の名前は1〜${LIMITS.label}文字で入力してください。`);
  const times={};
  for(const [key,name] of [['startsTime','開演時刻'],['opensTime','受付開始時刻'],['closesTime','受付終了時刻']]){
    if(typeof body?.[key]!=='string'||!TIME.test(body[key]))throw new SeirikenError(`${name}を「10:00」の形式で入力してください。`);
    times[key]=body[key];
  }
  if(times.opensTime>=times.closesTime)throw new SeirikenError('受付終了時刻は受付開始時刻より後にしてください。');
  return {
    label,...times,
    capacity:int(body?.capacity,1,LIMITS.capacity,'定員'),
    maxParty:int(body?.maxParty,1,LIMITS.party,'1枚あたりの最大人数'),
    finishAfter:int(body?.finishAfterMinutes,0,LIMITS.finish,'終了扱いまでの時間（分）')
  };
}

export function adminOperation(storage,body,now){
  const {sqlite}=storage;
  const action=body?.action;
  return storage.transaction(()=>{
    if(action==='settings'){
      if(!validDate(body.eventDate))throw new SeirikenError('開催日を正しく入力してください。');
      sqlite.prepare("UPDATE settings SET value=? WHERE key='event_date'").run(body.eventDate);
      record(sqlite,now,action,{eventDate:body.eventDate});
      return {ok:true};
    }
    if(action==='create'){
      const v=roundInput(body),stamp=now.toISOString();
      const r=sqlite.prepare('INSERT INTO rounds(label,starts_time,opens_time,closes_time,capacity_people,max_party,finish_after_minutes,paused,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)')
        .run(v.label,v.startsTime,v.opensTime,v.closesTime,v.capacity,v.maxParty,v.finishAfter,stamp,stamp);
      record(sqlite,now,action,{id:Number(r.lastInsertRowid),...v});
      return {ok:true,id:Number(r.lastInsertRowid)};
    }
    const id=int(body?.id,1,Number.MAX_SAFE_INTEGER,'回');
    const row=roundRow(sqlite,id);
    if(!row)throw new SeirikenError('この回は見つかりません。',404,'not_found');
    if(action==='update'){
      const v=roundInput(body);
      if(v.capacity<row.used_people)throw new SeirikenError(`すでに ${row.used_people} 名分を発行しているため、定員をそれより少なくできません。`,409);
      sqlite.prepare('UPDATE rounds SET label=?,starts_time=?,opens_time=?,closes_time=?,capacity_people=?,max_party=?,finish_after_minutes=?,updated_at=? WHERE id=?')
        .run(v.label,v.startsTime,v.opensTime,v.closesTime,v.capacity,v.maxParty,v.finishAfter,now.toISOString(),id);
      record(sqlite,now,action,{id,...v});
      return {ok:true};
    }
    if(action==='pause'||action==='resume'){
      sqlite.prepare('UPDATE rounds SET paused=?,updated_at=? WHERE id=?').run(action==='pause'?1:0,now.toISOString(),id);
      record(sqlite,now,action,{id});
      return {ok:true};
    }
    if(action==='delete'){
      if(row.active_count+row.cancelled_count>0)throw new SeirikenError('整理券を発行した回は削除できません。受付を止める場合は一時停止を使ってください。',409);
      sqlite.prepare('DELETE FROM rounds WHERE id=?').run(id);
      record(sqlite,now,action,{id,label:row.label});
      return {ok:true};
    }
    throw new SeirikenError('この操作は利用できません。',404);
  });
}

export function listTickets(sqlite,query,now){
  const roundId=Number(query.round);
  if(!Number.isSafeInteger(roundId)||roundId<1)throw new SeirikenError('回を選んでください。');
  const round=sqlite.prepare('SELECT * FROM rounds WHERE id=?').get(roundId);
  if(!round)throw new SeirikenError('この回は見つかりません。',404,'not_found');
  const number=query.number?Number(query.number):null;
  if(number!==null&&(!Number.isSafeInteger(number)||number<1))throw new SeirikenError('番号は数字で入力してください。');
  const rows=number===null
    ?sqlite.prepare('SELECT * FROM tickets WHERE round_id=? ORDER BY number DESC LIMIT 5000').all(roundId)
    :sqlite.prepare('SELECT * FROM tickets WHERE round_id=? AND number=?').all(roundId,number);
  const date=eventDate(sqlite);
  return {tickets:rows.map(t=>adminTicketView(t,round,date,now))};
}

const csvCell=v=>{const s=String(v??'');return /[",\r\n]/.test(s)||/^[=+\-@\t\r]/.test(s)?`"${(/^[=+\-@\t\r]/.test(s)?"'":'')+s.replace(/"/g,'""')}"`:s;};
export function ticketsCsv(sqlite){
  const rows=sqlite.prepare('SELECT t.*,r.label,r.starts_time FROM tickets t JOIN rounds r ON r.id=t.round_id ORDER BY r.starts_time,r.id,t.number').all();
  const head=['回','開演','番号','子ども','未就学児','小学生','中学生','高校生','保護者','状態','発行時刻','取消時刻','取り消した人','整理券ID'];
  const lines=rows.map(t=>[t.label,t.starts_time,t.number,t.party_size,t.preschool,t.elementary,t.junior_high,t.high_school,t.guardians,t.status==='active'?'有効':'取消',jstTime(t.created_at),t.cancelled_at?jstTime(t.cancelled_at):'',t.cancelled_by==='visitor'?'本人':t.cancelled_by==='staff'?'スタッフ':'',t.id].map(csvCell).join(','));
  return '\uFEFF'+[head.join(','),...lines].join('\r\n')+'\r\n';
}
