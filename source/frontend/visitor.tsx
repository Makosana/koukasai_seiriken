import {useCallback,useEffect,useRef,useState} from 'react';
import {Ticket as TicketIcon,Clock3,Users,ChevronRight,RefreshCw,TriangleAlert,ArrowLeft,Minus,Plus,Info,CheckCircle2,Link2,Copy,Share2,MapPin,Hourglass,X} from 'lucide-react';
import {ApiError,newId,scope,clockSeconds,dateLabel} from './lib/api';
import {backend,MODE,type Saved,type SavedWait} from './lib/backend';
import type {Children,EventInfo,PublicRound,PublicState,Ticket,WaitEntry} from './lib/types';
import {STATUS_LABELS,CHILD_KINDS,MAX_GUARDIANS,emptyChildren,childTotal,needsGuardian,childSummary,checkinPayload,overlaps} from './lib/types';
import {content} from './content';
import {Dialog,Toast,useQr} from './ui';

const DEVICE_KEY=`seiriken-${scope}-device-v1`,TICKETS_KEY=`seiriken-${scope}-tickets-v1`,PENDING_KEY=`seiriken-${scope}-pending-v1`,OLD_NAME_KEY=`seiriken-${scope}-name-v1`,WAITS_KEY=`seiriken-${scope}-waits-v1`;
const WAITLIST=MODE==='supabase';
type Pending={requestId:string;roundId:number;children:Children;guardians:number};
type Form={round:PublicRound;children:Children;guardians:number;mode:'issue'|'wait'};

function load<T>(key:string,fallback:T):T{const raw=localStorage.getItem(key);if(!raw)return fallback;try{return JSON.parse(raw) as T;}catch{return fallback;}}
function deviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id=newId();localStorage.setItem(DEVICE_KEY,id);}return id;}
export const tone=(roundId:number)=>`tone-${roundId%6}`;
const byStart=(a:Ticket,b:Ticket)=>a.starts_at.localeCompare(b.starts_at)||a.number-b.number;
const LINK=/^#\/t\/([0-9a-fA-F-]{36})\/([A-Za-z0-9_-]{16,128})$/;
const ticketLink=(t:Ticket)=>`${location.origin}${location.pathname}#/t/${t.id}/${t.token}`;
const cachedTickets=(list:Saved[])=>list.map(s=>s.ticket).filter((t):t is Ticket=>!!t).sort(byStart);
const cachedWaits=(list:SavedWait[])=>list.map(s=>s.entry).filter((e):e is WaitEntry=>!!e).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
function validSaved(s:Saved|null){
  if(typeof s?.id!=='string'||typeof s?.token!=='string')return null;
  const t=s.ticket;
  const ok=t&&typeof t==='object'&&t.id===s.id&&typeof t.number==='number'&&typeof t.starts_at==='string'&&typeof t.round_label==='string';
  return {id:s.id,token:s.token,...(ok?{ticket:t}:{})};
}
function validWait(s:SavedWait|null){
  if(typeof s?.id!=='string'||typeof s?.token!=='string')return null;
  const e=s.entry;
  const ok=e&&typeof e==='object'&&e.id===s.id&&typeof e.starts_at==='string'&&typeof e.round_label==='string';
  return {id:s.id,token:s.token,...(ok?{entry:e}:{})};
}
function takeLink(list:Saved[]):{list:Saved[];id:string|null}{
  const m=LINK.exec(location.hash);if(!m)return {list,id:null};
  const id=m[1].toLowerCase();
  history.replaceState(null,'',location.pathname+location.search+'#/ticket');
  return {list:list.some(s=>s.id===id)?list:[...list,{id,token:m[2]}],id};
}
const sameParty=(p:Pending,f:Form)=>p.roundId===f.round.id&&p.guardians===f.guardians&&CHILD_KINDS.every(k=>p.children[k.key]===f.children[k.key]);
export function partyText(t:{party_size:number;children?:Children;guardians?:number}){
  const kids=t.children&&childTotal(t.children)?`子ども ${t.party_size}名（${childSummary(t.children)}）`:`${t.party_size}名`;
  return t.guardians?`${kids}・保護者 ${t.guardians}名`:kids;
}

function minutesUntil(iso:string,now:number){return Math.max(1,Math.ceil((Date.parse(iso)-now)/60000));}
function roundNote(r:PublicRound,now:number){
  if(r.status==='before'){const m=minutesUntil(r.opens_at,now);return `${r.opens_time} から受付を開始します（あと約${m>=60?`${Math.floor(m/60)}時間${m%60?`${m%60}分`:''}`:`${m}分`}）。`;}
  if(r.status==='paused')return '受付を一時停止しています。しばらくしてから画面を更新してください。';
  if(r.status==='full')return r.waiting_count>0?'満員です。キャンセル待ちの方から順にご案内しています。':'満員になりました。取消が出ると、再び受け付けます。';
  if(r.status==='closed')return '受付は終了しました。';
  if(r.status==='finished')return 'この回は終了しました。';
  return '';
}
const WAIT_ENDED:Partial<Record<WaitEntry['status'],string>>={
  removed:'時間が重なる別の回の整理券が発行されたため、このキャンセル待ちは自動で外れました。',
  expired:'開演時刻までに空きが出なかったため、キャンセル待ちは終了しました。ご希望に添えず申し訳ありません。'
};

export default function Visitor({page,eventId}:{page:'home'|'ticket';eventId:number|null}){
  const [state,setState]=useState<PublicState|null>(null);
  const [offset,setOffset]=useState(0),[now,setNow]=useState(Date.now());
  const [saved,setSaved]=useState<Saved[]>([]),[tickets,setTickets]=useState<Ticket[]>([]);
  const [waits,setWaits]=useState<WaitEntry[]>([]);
  const [connection,setConnection]=useState<'loading'|'ok'|'error'>('loading');
  const [storageError,setStorageError]=useState(false);
  const [form,setForm]=useState<Form|null>(null);
  const [cancelTarget,setCancelTarget]=useState<Ticket|null>(null),[linkTarget,setLinkTarget]=useState<Ticket|null>(null);
  const [leaveTarget,setLeaveTarget]=useState<WaitEntry|null>(null);
  const [checked,setChecked]=useState<'pending'|'ok'|'failed'>('pending');
  const [pending,setPending]=useState<Pending|null>(null);
  const [busy,setBusy]=useState(false),[issuing,setIssuing]=useState(false),[highlight,setHighlight]=useState<string|null>(null);
  const [toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
  const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null),savedRef=useRef<Saved[]>([]),waitsRef=useRef<SavedWait[]>([]),busyRef=useRef(false);
  const waitRequest=useRef<{key:string;requestId:string}|null>(null);

  const notify=useCallback((text:string,error=false)=>{setToast({text,error});if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),error?9000:6000);},[]);
  const persist=useCallback((list:Saved[])=>{savedRef.current=list;setSaved(list);try{localStorage.setItem(TICKETS_KEY,JSON.stringify(list));}catch{setStorageError(true);}},[]);
  const persistWaits=useCallback((list:SavedWait[])=>{waitsRef.current=list;setWaits(cachedWaits(list));try{localStorage.setItem(WAITS_KEY,JSON.stringify(list));}catch{setStorageError(true);}},[]);
  const addTicket=useCallback((t:Ticket)=>{
    const token=t.token??savedRef.current.find(s=>s.id===t.id)?.token;
    if(!token)return;
    const next=[...savedRef.current.filter(s=>s.id!==t.id),{id:t.id,token,ticket:{...t,token}}];
    persist(next);setTickets(cachedTickets(next));
  },[persist]);

  const refreshRounds=useCallback(async()=>{
    try{const s:PublicState=await (await backend()).publicState();setState(s);setOffset(Date.parse(s.now)-Date.now());setConnection('ok');}
    catch{setConnection('error');}
  },[]);
  const refreshTickets=useCallback(async(list=savedRef.current)=>{
    if(!list.length){setTickets([]);setChecked('ok');return;}
    try{
      const r=await (await backend()).lookup(list.map(({id,token})=>({id,token})));
      const result=new Map(list.map((s,i)=>[s.id,r.tickets[i]??null]));
      const next=savedRef.current.flatMap(s=>{
        if(!result.has(s.id))return [s];
        const t=result.get(s.id);
        return t?[{id:s.id,token:t.token??s.token,ticket:t}]:[];
      });
      persist(next);setTickets(cachedTickets(next));setChecked('ok');
    }catch{setConnection('error');setChecked('failed');}
  },[persist]);
  // 繰り上がったキャンセル待ちは、発行された整理券に置きかえる
  const refreshWaits=useCallback(async(list=waitsRef.current)=>{
    if(!WAITLIST||!list.length)return;
    try{
      const r=await (await backend()).lookupWaitlist(list.map(({id,token})=>({id,token})));
      const result=new Map(list.map((s,i)=>[s.id,r.entries[i]??null]));
      const promoted:Ticket[]=[];
      const next=waitsRef.current.flatMap(s=>{
        if(!result.has(s.id))return [s];
        const e=result.get(s.id);
        if(!e||e.status==='cancelled')return [];
        if(e.status==='promoted'){if(e.ticket)promoted.push(e.ticket);return [];}
        return [{id:s.id,token:s.token,entry:e}];
      });
      persistWaits(next);
      for(const t of promoted){
        const fresh=!savedRef.current.some(s=>s.id===t.id);
        addTicket(t);
        if(fresh){setHighlight(t.id);notify(`キャンセル待ちから、${t.event_label?`${t.event_label} `:''}${t.round_label}の整理券（No.${t.number}）が発行されました。`);}
      }
    }catch{setConnection('error');}
  },[persistWaits,addTicket,notify]);

  function savePending(p:Pending|null){
    setPending(p);
    try{if(p)localStorage.setItem(PENDING_KEY,JSON.stringify(p));else localStorage.removeItem(PENDING_KEY);}catch{setStorageError(true);}
  }

  useEffect(()=>{
    let list:Saved[]=[],waitList:SavedWait[]=[],p:Pending|null=null;
    try{
      deviceId();
      localStorage.removeItem(OLD_NAME_KEY);
      const raw=load<Saved[]>(TICKETS_KEY,[]);
      list=(Array.isArray(raw)?raw:[]).map(validSaved).filter((s):s is Saved=>!!s);
      const rawWaits=load<SavedWait[]>(WAITS_KEY,[]);
      waitList=(Array.isArray(rawWaits)?rawWaits:[]).map(validWait).filter((s):s is SavedWait=>!!s);
      p=load<Pending|null>(PENDING_KEY,null);
    }catch{setStorageError(true);}
    const linked=takeLink(list);
    list=linked.list;
    if(linked.id){setHighlight(linked.id);try{localStorage.setItem(TICKETS_KEY,JSON.stringify(list));}catch{setStorageError(true);}}
    savedRef.current=list;setSaved(list);setTickets(cachedTickets(list));
    waitsRef.current=waitList;setWaits(cachedWaits(waitList));
    if(p?.requestId&&p.children)setPending({requestId:p.requestId,roundId:p.roundId,children:p.children,guardians:p.guardians});else if(p){try{localStorage.removeItem(PENDING_KEY);}catch{}}
    refreshRounds();refreshTickets(list).then(()=>refreshWaits(waitList));
    const all=()=>{refreshRounds();refreshTickets().then(()=>refreshWaits());};
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&!busyRef.current)all();},10000);
    const tick=setInterval(()=>setNow(Date.now()),1000);
    const visible=()=>{if(document.visibilityState==='visible')all();};
    const hash=()=>{const l=takeLink(savedRef.current);if(l.id){persist(l.list);setTickets(cachedTickets(l.list));setHighlight(l.id);refreshTickets(l.list);}};
    document.addEventListener('visibilitychange',visible);window.addEventListener('hashchange',hash);
    return()=>{clearInterval(poll);clearInterval(tick);document.removeEventListener('visibilitychange',visible);window.removeEventListener('hashchange',hash);if(toastTimer.current)clearTimeout(toastTimer.current);};
  },[refreshRounds,refreshTickets,refreshWaits,persist]);

  useEffect(()=>{
    if(page!=='ticket'||!highlight)return;
    const timer=setTimeout(()=>document.getElementById(`ticket-${highlight}`)?.scrollIntoView({behavior:'smooth',block:'center'}),80);
    return()=>clearTimeout(timer);
  },[page,highlight,tickets.length]);
  useEffect(()=>{window.scrollTo(0,0);},[eventId]);

  const waitingCheckin=page==='ticket'&&tickets.some(t=>t.status==='active'&&!t.round_finished&&t.checkin_code&&!t.checked_in_at);
  useEffect(()=>{
    if(!waitingCheckin)return;
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&!busyRef.current)refreshTickets();},4000);
    return()=>clearInterval(poll);
  },[waitingCheckin,refreshTickets]);

  const serverNow=now+offset;
  const activeTickets=tickets.filter(t=>t.status==='active'&&!t.round_finished);
  const openWaits=waits.filter(w=>w.status==='waiting');
  const mine=(roundId:number)=>tickets.find(t=>t.round_id===roundId&&t.status==='active');
  const myWait=(roundId:number)=>openWaits.find(w=>w.round_id===roundId);
  const roundById=(id:number)=>state?.rounds.find(r=>r.id===id);
  const eventById=(id:number|undefined)=>state?.events.find(e=>e.id===id);
  // 時間が重なる回の整理券をすでに持っていれば、その整理券
  const conflictOf=(r:PublicRound)=>activeTickets.find(t=>{if(t.round_id===r.id)return false;const x=roundById(t.round_id);return !!x&&overlaps(x,r);})??null;
  // 時間が重なる別の回のキャンセル待ち。残っている間は整理券を取れない
  const waitConflictsOf=(r:PublicRound)=>openWaits.filter(w=>{if(w.round_id===r.id)return false;const x=roundById(w.round_id);return !!x&&overlaps(x,r);});

  async function issue(f:Form){
    if(busyRef.current)return;
    const guardians=needsGuardian(f.children)?f.guardians:0;
    const op:Pending=pending&&sameParty(pending,{...f,guardians})?pending:{requestId:newId(),roundId:f.round.id,children:f.children,guardians};
    let device:string;
    try{device=deviceId();localStorage.setItem(PENDING_KEY,JSON.stringify(op));setPending(op);}
    catch{setStorageError(true);notify('このブラウザーでは整理券を保存できないため、申し込みを止めました。',true);return;}
    busyRef.current=true;setBusy(true);setIssuing(true);
    try{
      const r=await (await backend()).issue({roundId:op.roundId,children:op.children,guardians:op.guardians,deviceId:device,requestId:op.requestId});
      addTicket(r.ticket);savePending(null);setForm(null);setHighlight(r.ticket.id);
      notify(`${r.ticket.round_label}の整理券（No.${r.ticket.number}）を取りました。`);
      location.hash='#/ticket';
      refreshRounds();refreshWaits();
    }catch(e){
      const err=e instanceof ApiError?e:new ApiError('処理を完了できませんでした。',0,'network');
      if(err.code==='network'||err.status>=500){notify('通信が途中で途切れました。下の「結果を確認する」を押してください。',true);setForm(null);}
      else{savePending(null);setForm(null);notify(err.message,true);if(err.code==='already'||err.code==='overlap')refreshTickets();if(err.code==='wait_overlap')refreshWaits();}
      refreshRounds();
    }finally{busyRef.current=false;setBusy(false);setIssuing(false);}
  }

  async function join(f:Form){
    if(busyRef.current)return;
    const guardians=needsGuardian(f.children)?f.guardians:0;
    const key=JSON.stringify([f.round.id,f.children,guardians]);
    const requestId=waitRequest.current?.key===key?waitRequest.current.requestId:newId();
    waitRequest.current={key,requestId};
    let device:string;
    try{device=deviceId();}
    catch{setStorageError(true);notify('このブラウザーでは情報を保存できないため、登録を止めました。',true);return;}
    busyRef.current=true;setBusy(true);
    try{
      const r=await (await backend()).joinWaitlist({roundId:f.round.id,children:f.children,guardians,deviceId:device,requestId});
      waitRequest.current=null;
      persistWaits([...waitsRef.current.filter(s=>s.id!==r.entry.id),{id:r.entry.id,token:r.entry.token??'',entry:r.entry}]);
      setForm(null);
      notify(`${r.entry.round_label}のキャンセル待ちに登録しました（${r.entry.position??'-'}番目）。`);
      location.hash='#/ticket';
      refreshRounds();
    }catch(e){
      const err=e instanceof ApiError?e:new ApiError('処理を完了できませんでした。',0,'network');
      if(err.code==='network'||err.status>=500)notify('通信が途中で途切れました。もう一度「キャンセル待ちに登録」を押してください。二重に登録されることはありません。',true);
      else{waitRequest.current=null;setForm(null);notify(err.message,true);if(err.code==='already'||err.code==='overlap')refreshTickets();}
      refreshRounds();
    }finally{busyRef.current=false;setBusy(false);}
  }

  async function leave(w:WaitEntry){
    if(busyRef.current||!w.token)return;
    busyRef.current=true;setBusy(true);
    try{
      const r=await (await backend()).leaveWaitlist(w.id,w.token);
      setLeaveTarget(null);
      if(r.entry.status==='promoted'&&r.entry.ticket){addTicket(r.entry.ticket);notify('すでに繰り上がって、整理券が発行されていました。');}
      else notify('キャンセル待ちをやめました。');
      persistWaits(waitsRef.current.filter(s=>s.id!==w.id));
      refreshRounds();
    }catch(e){notify(e instanceof Error?e.message:'取りやめられませんでした。',true);setLeaveTarget(null);refreshWaits();}
    finally{busyRef.current=false;setBusy(false);}
  }
  const dismiss=(w:WaitEntry)=>persistWaits(waitsRef.current.filter(s=>s.id!==w.id));

  async function resolvePending(){
    if(!pending||busyRef.current)return;
    busyRef.current=true;setBusy(true);
    try{
      const r=await (await backend()).findRequest(pending.requestId,deviceId());
      savePending(null);
      if(r.ticket){addTicket(r.ticket);setHighlight(r.ticket.id);notify('整理券は発行されていました。');location.hash='#/ticket';}
      else notify('整理券は発行されていませんでした。もう一度お申し込みください。',true);
      refreshRounds();
    }catch(e){notify(e instanceof Error?e.message:'通信を確認できませんでした。',true);}
    finally{busyRef.current=false;setBusy(false);}
  }

  async function cancel(t:Ticket){
    if(busyRef.current||!t.token)return;
    busyRef.current=true;setBusy(true);
    try{
      const r=await (await backend()).cancel(t.id,t.token);
      addTicket(r.ticket);setCancelTarget(null);
      notify('整理券を取り消しました。');refreshRounds();
    }catch(e){notify(e instanceof Error?e.message:'取り消せませんでした。',true);setCancelTarget(null);refreshTickets();}
    finally{busyRef.current=false;setBusy(false);}
  }

  const header=<header className="v-header">
    <a className="v-brand" href="#/"><span className="brand-icon small"><TicketIcon size={20} strokeWidth={1.8}/></span><span><strong>{content.eventName}</strong><small>整理券</small></span></a>
    <span className="v-clock" aria-label="現在時刻"><Clock3 size={14}/>{clockSeconds(serverNow)}</span>
  </header>;

  const banners=<>
    {storageError&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>このブラウザーでは整理券を保存できません</strong><p>シークレットモードやプライベートブラウズを解除してから、もう一度開いてください。</p></div></div>}
    {connection==='error'&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>通信を確認できません</strong><p>{MODE==='supabase'?'インターネットにつながっているか確かめてください。':'会場のWi-Fiにつながっているか確かめてください。'}取った整理券はこのスマホに保存されています。</p></div><button className="button small" onClick={()=>{refreshRounds();refreshTickets();refreshWaits();}}><RefreshCw size={15}/>再読み込み</button></div>}
    {pending&&!issuing&&<div className="banner warning"><Clock3 size={20}/><div><strong>前回の申し込み結果を確認できていません</strong><p>整理券が発行されたかどうかを確かめます。何度も申し込む必要はありません。</p><div className="pending-actions"><button className="button small primary" disabled={busy} onClick={resolvePending}>{busy?<RefreshCw size={15} className="spin"/>:<CheckCircle2 size={15}/>}結果を確認する</button></div></div></div>}
  </>;
  const commonNotices=<section className="panel notices"><h2><Info size={17}/>ご注意</h2><ul>{content.notices.map(n=><li key={n}>{n}</li>)}{WAITLIST&&<li>{content.waitlistNotice}</li>}</ul></section>;
  const mineStrip=(activeTickets.length>0||openWaits.length>0)&&<a className="mine-strip" href="#/ticket"><TicketIcon size={20}/><span><strong>{[activeTickets.length?`整理券 ${activeTickets.length} 枚`:'',openWaits.length?`キャンセル待ち ${openWaits.length} 件`:''].filter(Boolean).join('・')}</strong><small>タップして表示します</small></span><ChevronRight size={18}/></a>;

  const leaveDialog=leaveTarget&&<Dialog title="キャンセル待ちをやめる" busy={busy} onClose={()=>setLeaveTarget(null)}>
    <span className="dialog-symbol red"><TriangleAlert size={24}/></span>
    <h2>キャンセル待ちをやめますか？</h2>
    <p className="dialog-description">{leaveTarget.event_label} {leaveTarget.round_label}（開演 {leaveTarget.starts_time}）のキャンセル待ちをやめます。もう一度登録すると、順番は最後になります。</p>
    <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setLeaveTarget(null)}>続ける</button><button className="button destructive" disabled={busy} onClick={()=>leave(leaveTarget)}>{busy&&<RefreshCw size={16} className="spin"/>}やめる</button></div>
  </Dialog>;

  if(page==='ticket'){
    const suggestionsFor=(w:WaitEntry)=>(state?.rounds??[])
      .filter(r=>r.status==='open'&&r.id!==w.round_id&&!mine(r.id)&&!conflictOf(r))
      .sort((a,b)=>Number(b.event_id===w.event_id)-Number(a.event_id===w.event_id)||a.starts_at.localeCompare(b.starts_at))
      .slice(0,3);
    const nothing=!tickets.length&&!waits.length;
    return <div className="v-shell">
      {header}
      <main className="v-main">
        <a className="back-link" href="#/"><ArrowLeft size={17}/>イベントの一覧へ戻る</a>
        <h1 className="v-title">あなたの整理券</h1>
        {banners}
        {checked==='failed'&&tickets.length>0&&<div className="banner warning"><Clock3 size={20}/><div><strong>前回確認した内容を表示しています</strong><p>通信がつながると、自動で最新の状態に更新します。</p></div></div>}
        {!tickets.length&&saved.length>0&&checked==='pending'&&<div className="table-loading"><RefreshCw size={16} className="spin"/>整理券を確認しています</div>}
        {!tickets.length&&saved.length>0&&checked==='failed'&&<div className="v-empty"><TriangleAlert size={36} strokeWidth={1.4}/><strong>整理券を表示できませんでした</strong><p>通信がつながると表示されます。電波の良い場所で「再読み込み」を押してください。</p></div>}
        {nothing&&(!saved.length||checked==='ok')&&<div className="v-empty"><TicketIcon size={36} strokeWidth={1.4}/><strong>整理券はまだありません</strong><p>イベントの一覧から、整理券を取ってください。別のブラウザーで取った場合は、そのとき保存した「整理券のリンク」を開いてください。</p><a className="button primary" href="#/">イベントの一覧へ<ChevronRight size={16}/></a></div>}
        {waits.length>0&&<div className="wait-list">{waits.map(w=><WaitCard key={w.id} w={w} suggestions={w.status==='waiting'?suggestionsFor(w):[]} eventOf={id=>eventById(id)} onLeave={()=>setLeaveTarget(w)} onDismiss={()=>dismiss(w)}/>)}</div>}
        <div className="ticket-list">{tickets.map(t=><TicketCard key={t.id} t={t} now={serverNow} highlight={t.id===highlight} onCancel={()=>setCancelTarget(t)} onLink={()=>setLinkTarget(t)}/>)}</div>
        {openWaits.length>0&&<p className="v-hint"><Info size={14}/>繰り上がると、この画面に整理券が表示されます。ときどきこの画面を開いて確かめてください。</p>}
        {tickets.some(t=>t.status==='active'&&!t.round_finished&&t.checkin_code&&!t.checked_in_at)&&<p className="v-hint"><Info size={14}/>入場口で、整理券のQRコードをスタッフに読み取ってもらってください。画面を明るくすると読み取りやすくなります。</p>}
        {tickets.length>0&&!tickets.some(t=>t.checkin_code)&&<p className="v-hint"><Info size={14}/>入場時にこの画面をスタッフに見せてください。時刻が動いていることを確認します。</p>}
        {tickets.some(t=>t.status==='active'&&!t.round_finished)&&<p className="v-hint"><Info size={14}/>整理券は、いま開いているブラウザーに保存されています。QRコードを別のアプリで読むと表示されないことがあるので、「整理券のリンクを保存」からリンクを残しておくと安心です。</p>}
      </main>
      <footer className="v-footer">{content.footer}</footer>
      {cancelTarget&&<Dialog title="整理券を取り消す" busy={busy} onClose={()=>setCancelTarget(null)}>
        <span className="dialog-symbol red"><TriangleAlert size={24}/></span>
        <h2>整理券を取り消しますか？</h2>
        <p className="dialog-description">{cancelTarget.event_label?`${cancelTarget.event_label} `:''}{cancelTarget.round_label}（開演 {cancelTarget.starts_time}）の No.{cancelTarget.number}・{partyText(cancelTarget)} を取り消します。取り消した整理券は元に戻せません。</p>
        <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setCancelTarget(null)}>やめる</button><button className="button destructive" disabled={busy} onClick={()=>cancel(cancelTarget)}>{busy&&<RefreshCw size={16} className="spin"/>}取り消す</button></div>
      </Dialog>}
      {leaveDialog}
      {linkTarget&&<LinkDialog t={linkTarget} notify={notify} onClose={()=>setLinkTarget(null)}/>}
      <Toast toast={toast} onClose={()=>setToast(null)}/>
    </div>;
  }

  const events=state?.events??[];
  const current:EventInfo|null=eventId!==null?eventById(eventId)??null:events.length===1?events[0]:null;
  const roundsOf=(id:number)=>(state?.rounds??[]).filter(r=>r.event_id===id);
  const showList=!!state&&eventId===null&&!current;

  return <div className="v-shell">
    {header}
    <main className="v-main">
      {current?<>
        {events.length>1&&<a className="back-link" href="#/"><ArrowLeft size={17}/>イベントの一覧へ戻る</a>}
        <section className="v-hero"><span className="eyebrow">{content.eventName} 整理券</span><h1>{current.label}</h1>{current.venue&&<p className="v-venue"><MapPin size={16}/>会場：{current.venue}</p>}</section>
        {banners}
        {mineStrip}
        {current.notice&&<section className="panel notices event-notice"><h2><Info size={17}/>このイベントのご案内</h2><p>{current.notice}</p></section>}
        <h2 className="v-section-title">回の一覧<span>{dateLabel(serverNow)}</span></h2>
        {!roundsOf(current.id).length&&<div className="v-empty"><Clock3 size={32} strokeWidth={1.4}/><strong>まだ回が登録されていません</strong><p>しばらくしてから、もう一度開いてください。</p></div>}
        <div className="round-list">{roundsOf(current.id).map(r=><RoundCard key={r.id} r={r} now={serverNow} owned={mine(r.id)} wait={myWait(r.id)} conflict={conflictOf(r)} waitConflicts={waitConflictsOf(r)} disabled={busy||storageError||!!pending}
          onIssue={()=>setForm({round:r,children:emptyChildren(),guardians:1,mode:'issue'})} onWait={()=>setForm({round:r,children:emptyChildren(),guardians:1,mode:'wait'})} onShow={id=>setHighlight(id)} onLeave={setLeaveTarget}/>)}</div>
        {commonNotices}
      </>:<>
        <section className="v-hero"><span className="eyebrow">NUMBERED TICKET</span><h1>{content.eventName}の整理券</h1><p>{content.lead}</p></section>
        {banners}
        {mineStrip}
        {!state&&connection==='loading'&&<div className="table-loading"><RefreshCw size={16} className="spin"/>読み込み中</div>}
        {state&&eventId!==null&&!current&&<div className="v-empty"><TriangleAlert size={32} strokeWidth={1.4}/><strong>このイベントは見つかりません</strong><p>イベントの一覧から選び直してください。</p><a className="button primary" href="#/">イベントの一覧へ<ChevronRight size={16}/></a></div>}
        {showList&&<>
          <h2 className="v-section-title">イベントを選んでください<span>{dateLabel(serverNow)}</span></h2>
          {!events.length&&<div className="v-empty"><Clock3 size={32} strokeWidth={1.4}/><strong>まだイベントが登録されていません</strong><p>しばらくしてから、もう一度開いてください。</p></div>}
          <div className="event-list">{events.map(ev=><EventCard key={ev.id} ev={ev} rounds={roundsOf(ev.id)}/>)}</div>
        </>}
        {commonNotices}
      </>}
    </main>
    <footer className="v-footer">{content.footer}</footer>
    {leaveDialog}
    {form&&(()=>{
      const round=state?.rounds.find(x=>x.id===form.round.id)??form.round;
      const waitMode=form.mode==='wait';
      const total=childTotal(form.children),max=waitMode?round.max_party:Math.max(0,Math.min(round.max_party,round.remaining)),guardian=needsGuardian(form.children);
      const setKind=(key:keyof Children,value:number)=>setForm({...form,children:{...form.children,[key]:value}});
      const ev=eventById(round.event_id);
      return <Dialog title={waitMode?'キャンセル待ちに登録':'整理券を取る'} busy={busy} onClose={()=>setForm(null)}>
        <span className="dialog-symbol">{waitMode?<Hourglass size={24}/>:<TicketIcon size={24}/>}</span>
        <h2>{ev?`${ev.label} `:''}{round.label}（開演 {round.starts_time}）</h2>
        {waitMode
          ?<p className="dialog-description">いま {round.waiting_count} 組が待っています。空きが出ると、登録した順に自動で整理券をお取りします。<strong>必ず繰り上がるとは限りません。</strong>1枚で子ども {round.max_party} 名までです。</p>
          :<p className="dialog-description">入場するお子さまの人数を、区分ごとに選んでください。1枚で子ども {round.max_party} 名まで、残りは {round.remaining} 名分です。</p>}
        <div className="party-form">
          {CHILD_KINDS.map(k=><Stepper key={k.key} label={k.label} value={form.children[k.key]} min={0} canAdd={total<max} disabled={busy} onChange={v=>setKind(k.key,v)}/>)}
          {guardian&&<div className="party-guardian">
            <Stepper label="保護者" note="定員には数えません" value={form.guardians} min={0} canAdd={form.guardians<MAX_GUARDIANS} disabled={busy} onChange={v=>setForm({...form,guardians:v})}/>
            <p>未就学児・小学生と一緒に入場する保護者の人数です。</p>
          </div>}
        </div>
        <div className="confirm-values"><div className="emphasis"><span>子ども</span><strong>{total} 名</strong></div>{guardian&&<div><span>保護者</span><strong>{form.guardians} 名</strong></div>}</div>
        <p className="dialog-description">{waitMode?'繰り上がったときは、「整理券を見る」の画面に整理券が表示されます。人数が多いと、空きが少ないときに繰り上がりにくくなります。':'整理券はこのスマホに保存されます。1つの回につき1枚までです。'}</p>
        <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setForm(null)}>戻る</button>
          <button className="button primary" disabled={busy||total<1||total>max} onClick={()=>waitMode?join({...form,round}):issue({...form,round})}>{busy?<RefreshCw size={16} className="spin"/>:waitMode?<Hourglass size={16}/>:<Users size={16}/>}{waitMode?'キャンセル待ちに登録':'整理券を取る'}</button></div>
      </Dialog>;
    })()}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;
}

function EventCard({ev,rounds}:{ev:EventInfo;rounds:PublicRound[]}){
  const next=rounds.find(r=>r.status!=='finished'&&r.status!=='closed');
  const open=rounds.filter(r=>r.status==='open').length,waitable=rounds.filter(r=>r.waitlist_open).length;
  return <a className="event-card" href={`#/e/${ev.id}`}>
    <span className={`round-tone ${tone(ev.id)}`}/>
    <div className="event-main">
      <h3>{ev.label}</h3>
      {ev.venue&&<p><MapPin size={14}/>{ev.venue}</p>}
      <p className="event-sub">{rounds.length?(next?`次の回 ${next.starts_time}（${STATUS_LABELS[next.status]}）・全 ${rounds.length} 回`:`本日の受付は終了しました・全 ${rounds.length} 回`):'回はまだ登録されていません'}</p>
      <div className="event-chips">{open>0&&<span className="status-chip status-open"><span/>受付中 {open} 回</span>}{waitable>0&&<span className="status-chip status-full"><span/>キャンセル待ち受付中</span>}</div>
    </div>
    <ChevronRight size={20}/>
  </a>;
}

function RoundCard({r,now,owned,wait,conflict,waitConflicts,disabled,onIssue,onWait,onShow,onLeave}:{r:PublicRound;now:number;owned?:Ticket;wait?:WaitEntry;conflict:Ticket|null;waitConflicts:WaitEntry[];disabled:boolean;onIssue:()=>void;onWait:()=>void;onShow:(id:string)=>void;onLeave:(w:WaitEntry)=>void}){
  const conflictNote=conflict&&<p className="round-conflict"><TriangleAlert size={15}/>時間が重なる回（{conflict.event_label?`${conflict.event_label} `:''}{conflict.round_label}・開演 {conflict.starts_time}）の整理券をお持ちのため、申し込めません。</p>;
  const waitBlocked=!conflict&&waitConflicts.length>0;
  const waitNote=waitBlocked&&<div className="round-conflict"><TriangleAlert size={15}/><div>
    <p>時間が重なる回（{waitConflicts.map(w=>`${w.event_label} ${w.round_label}・開演 ${w.starts_time}`).join('、')}）のキャンセル待ちをしているため、申し込めません。キャンセル待ちをやめると申し込めます。</p>
    <div className="round-conflict-actions">{waitConflicts.map(w=><button key={w.id} className="button small" disabled={disabled} onClick={()=>onLeave(w)}>{w.event_label} {w.round_label}のキャンセル待ちをやめる</button>)}</div>
  </div></div>;
  let action;
  if(owned)action=<a className="button full" href="#/ticket" onClick={()=>onShow(owned.id)}><TicketIcon size={17}/>整理券を見る（No.{owned.number}）</a>;
  else if(wait)action=<a className="button full wait-button" href="#/ticket"><Hourglass size={17}/>キャンセル待ち中（{wait.position??'-'}番目）</a>;
  else if(r.status==='open')action=conflict?conflictNote:waitBlocked?waitNote:<button className="button primary full" disabled={disabled} onClick={onIssue}><TicketIcon size={17}/>整理券を取る</button>;
  else if(r.status==='full'&&r.waitlist_open&&WAITLIST)action=<>
    <p className="round-note">{r.waiting_count>0?`満員です。いま ${r.waiting_count} 組がキャンセル待ちをしています。`:'満員です。キャンセル待ちに登録できます。'}</p>
    {conflict?conflictNote:<button className="button full wait-button" disabled={disabled} onClick={onWait}><Hourglass size={17}/>キャンセル待ちに登録</button>}
  </>;
  else action=<p className="round-note">{roundNote(r,now)}</p>;
  return <article className={`round-card ${r.status==='finished'?'finished':''}`}>
    <div className="round-head"><span className={`round-tone ${tone(r.id)}`}/><div><h3>{r.label}</h3><p>開演 <strong>{r.starts_time}</strong><small>（終演予定 {r.ends_time}）</small></p></div><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span></div>
    <dl className="round-meta"><div><dt>受付時間</dt><dd>{r.opens_time}〜{r.closes_time}</dd></div><div><dt>残り</dt><dd className={r.remaining>0&&r.remaining<=Math.max(5,r.capacity_people*0.1)?'low':''}>{r.status==='finished'?'—':`${r.remaining} 名`}<small> / {r.capacity_people} 名</small></dd></div></dl>
    {action}
    {r.status==='open'&&!owned&&!wait&&!conflict&&!waitBlocked&&<p className="round-sub">1枚で子ども最大 {r.max_party} 名まで申し込めます。未就学児・小学生は、保護者の方も一緒に入場できます（定員には数えません）。</p>}
  </article>;
}

function WaitCard({w,suggestions,eventOf,onLeave,onDismiss}:{w:WaitEntry;suggestions:PublicRound[];eventOf:(id:number)=>EventInfo|undefined;onLeave:()=>void;onDismiss:()=>void}){
  const ended=WAIT_ENDED[w.status];
  return <article className={`wait-card ${ended?'ended':''}`}>
    <div className="wait-band"><Hourglass size={15}/><span>キャンセル待ち</span></div>
    <div className="wait-body">
      <div className="ticket-round"><strong>{w.event_label} {w.round_label}</strong><span>開演 {w.starts_time}{w.venue?`・${w.venue}`:''}</span></div>
      {ended?<p className="wait-ended">{ended}</p>:<>
        <div className="wait-position"><span>いま</span><strong>{w.position??'-'}</strong><span>番目</span></div>
        <div className="ticket-party"><Users size={18}/>{partyText(w)}</div>
        <p className="wait-note">空きが出ると、登録した順に自動で整理券をお取りします。<strong>必ず繰り上がるとは限りません。</strong>開演時刻までに繰り上がらなかったときは、自動で終了します。</p>
        {suggestions.length>0&&<div className="wait-suggest">
          <p>いま空きのある回</p>
          <ul>{suggestions.map(r=><li key={r.id}><a href={`#/e/${r.event_id}`}><span>{eventOf(r.event_id)?.label} {r.label}</span><span>開演 {r.starts_time}・残り {r.remaining} 名</span><ChevronRight size={15}/></a></li>)}</ul>
          <small>このキャンセル待ちと時間が重なる回の整理券を取るときは、先にキャンセル待ちをやめてください。</small>
        </div>}
      </>}
    </div>
    <div className="ticket-foot">{ended?<button className="text-link" onClick={onDismiss}><X size={14}/>この表示を閉じる</button>:<button className="text-link danger-link" onClick={onLeave}>キャンセル待ちをやめる</button>}</div>
  </article>;
}

function Stepper({label,note,value,min,canAdd,disabled,onChange}:{label:string;note?:string;value:number;min:number;canAdd:boolean;disabled:boolean;onChange:(v:number)=>void}){
  return <div className="party-row">
    <span className="party-label">{label}{note&&<small>{note}</small>}</span>
    <div className="party-control" aria-label={`${label}の人数`}><button type="button" aria-label={`${label}を1名減らす`} disabled={disabled||value<=min} onClick={()=>onChange(value-1)}><Minus size={18}/></button><span><strong>{value}</strong>名</span><button type="button" aria-label={`${label}を1名増やす`} disabled={disabled||!canAdd} onClick={()=>onChange(value+1)}><Plus size={18}/></button></div>
  </div>;
}

function LinkDialog({t,notify,onClose}:{t:Ticket;notify:(text:string,error?:boolean)=>void;onClose:()=>void}){
  const link=ticketLink(t);
  async function copy(){
    try{await navigator.clipboard.writeText(link);notify('リンクをコピーしました。LINEのKeepやメモに貼り付けて保存してください。');}
    catch{notify('コピーできませんでした。下のリンクを長押ししてコピーしてください。',true);}
  }
  async function share(){
    try{await navigator.share({title:`${t.round_label} 整理券 No.${t.number}`,url:link});}
    catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))copy();}
  }
  return <Dialog title="整理券のリンク" onClose={onClose}>
    <span className="dialog-symbol"><Link2 size={24}/></span>
    <h2>整理券のリンクを保存</h2>
    <p className="dialog-description">このリンクを開くと、どのブラウザーからでも {t.round_label} の No.{t.number} を表示できます。LINEのKeep（自分だけのトーク）やメモ帳に保存しておくと安心です。</p>
    <input className="link-box" readOnly value={link} onFocus={e=>e.currentTarget.select()} aria-label="整理券のリンク"/>
    <p className="link-warning"><TriangleAlert size={14}/>このリンクを知っている人は、整理券の表示と取消ができます。ほかの人には送らないでください。</p>
    <div className="dialog-buttons">
      <button className="button" onClick={copy}><Copy size={16}/>コピー</button>
      {'share' in navigator&&<button className="button primary" onClick={share}><Share2 size={16}/>共有・保存</button>}
    </div>
  </Dialog>;
}

const checkedTime=(iso:string)=>new Date(iso).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false});

function TicketCard({t,now,highlight,onCancel,onLink}:{t:Ticket;now:number;highlight:boolean;onCancel:()=>void;onLink:()=>void}){
  const live=t.status==='active'&&!t.round_finished;
  const checked=t.status==='active'&&!!t.checked_in_at;
  const qr=useQr(live&&!checked&&t.checkin_code?checkinPayload(t.checkin_code):'');
  return <article id={`ticket-${t.id}`} className={`ticket-card ${tone(t.round_id)} ${t.status==='cancelled'?'cancelled':''} ${t.round_finished?'finished':''} ${highlight?'highlight':''}`}>
    <div className="ticket-band"><span>{content.eventName} {t.event_label||content.performanceName}</span><span>整理券</span></div>
    <div className="ticket-body">
      <div className="ticket-round"><strong>{t.round_label}</strong><span>開演 {t.starts_time}{t.ends_time?`（終演予定 ${t.ends_time}）`:''}</span>{t.venue&&<span className="ticket-venue"><MapPin size={13}/>{t.venue}</span>}</div>
      <div className="ticket-number"><span>No.</span>{t.number}</div>
      <div className="ticket-party"><Users size={20}/>{t.children&&childTotal(t.children)?<>子ども {t.party_size} 名{t.guardians?<span className="ticket-guardians">＋保護者 {t.guardians} 名</span>:null}</>:<>{t.party_size} 名</>}</div>
      {t.children&&childTotal(t.children)>0&&<div className="ticket-kinds">{childSummary(t.children).replace(/(\d+)/g,' $1名')}</div>}
      {checked&&<div className="ticket-checked" role="status"><CheckCircle2 size={30}/><span><strong>受付済み</strong><small>{checkedTime(t.checked_in_at!)} に入場受付をしました</small></span></div>}
      {qr&&<div className="ticket-qr"><img src={qr} alt="入場受付用のQRコード"/><small>入場口でこのQRコードを読み取ってもらってください</small></div>}
      {live&&<div className="ticket-live" aria-label="現在時刻"><span className="live-dot"/>{dateLabel(now)}<strong>{clockSeconds(now)}</strong></div>}
      {t.status==='cancelled'&&<div className="ticket-state">{t.cancelled_by==='staff'?'スタッフにより取り消された整理券です':'取り消した整理券です'}</div>}
      {t.status==='active'&&t.round_finished&&<div className="ticket-state">この回は終了しました</div>}
    </div>
    {live&&!checked&&t.token&&<div className="ticket-foot ticket-link"><button className="text-link" onClick={onLink}><Link2 size={14}/>整理券のリンクを保存（別のブラウザー用）</button></div>}
    {live&&<div className="ticket-foot">{t.cancellable?<button className="text-link danger-link" onClick={onCancel}>この整理券を取り消す</button>:<span>{checked?'受付が済んでいるため、取り消しはできません':'開演時刻を過ぎたため、取り消しはできません'}</span>}</div>}
    <div className="ticket-shine" aria-hidden="true"/>
  </article>;
}
