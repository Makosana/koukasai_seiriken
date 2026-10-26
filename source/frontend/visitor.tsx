import {useCallback,useEffect,useRef,useState} from 'react';
import {Ticket as TicketIcon,Clock3,Users,ChevronRight,RefreshCw,TriangleAlert,ArrowLeft,Minus,Plus,Info,CheckCircle2,Link2,Copy,Share2} from 'lucide-react';
import {ApiError,newId,scope,clockSeconds,dateLabel} from './lib/api';
import {backend,MODE,type Saved} from './lib/backend';
import type {Children,PublicRound,PublicState,Ticket} from './lib/types';
import {STATUS_LABELS,CHILD_KINDS,MAX_GUARDIANS,MAX_NAME,emptyChildren,childTotal,needsGuardian,childSummary} from './lib/types';
import {content} from './content';
import {Dialog,Toast} from './ui';

const DEVICE_KEY=`seiriken-${scope}-device-v1`,TICKETS_KEY=`seiriken-${scope}-tickets-v1`,PENDING_KEY=`seiriken-${scope}-pending-v1`,NAME_KEY=`seiriken-${scope}-name-v1`;
type Pending={requestId:string;roundId:number;children:Children;guardians:number;name:string};
type Form={round:PublicRound;children:Children;guardians:number;name:string};

function load<T>(key:string,fallback:T):T{const raw=localStorage.getItem(key);if(!raw)return fallback;try{return JSON.parse(raw) as T;}catch{return fallback;}}
function savedName(){try{return localStorage.getItem(NAME_KEY)??'';}catch{return '';}}
function deviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id=newId();localStorage.setItem(DEVICE_KEY,id);}return id;}
export const tone=(roundId:number)=>`tone-${roundId%6}`;
const byStart=(a:Ticket,b:Ticket)=>a.starts_at.localeCompare(b.starts_at)||a.number-b.number;
const LINK=/^#\/t\/([0-9a-fA-F-]{36})\/([A-Za-z0-9_-]{16,128})$/;
const ticketLink=(t:Ticket)=>`${location.origin}${location.pathname}#/t/${t.id}/${t.token}`;
const cachedTickets=(list:Saved[])=>list.map(s=>s.ticket).filter((t):t is Ticket=>!!t).sort(byStart);
function validSaved(s:Saved|null){
  if(typeof s?.id!=='string'||typeof s?.token!=='string')return null;
  const t=s.ticket;
  const ok=t&&typeof t==='object'&&t.id===s.id&&typeof t.number==='number'&&typeof t.starts_at==='string'&&typeof t.round_label==='string';
  return {id:s.id,token:s.token,...(ok?{ticket:t}:{})};
}
function takeLink(list:Saved[]):{list:Saved[];id:string|null}{
  const m=LINK.exec(location.hash);if(!m)return {list,id:null};
  const id=m[1].toLowerCase();
  history.replaceState(null,'',location.pathname+location.search+'#/ticket');
  return {list:list.some(s=>s.id===id)?list:[...list,{id,token:m[2]}],id};
}
const sameParty=(p:Pending,f:Form)=>p.roundId===f.round.id&&p.guardians===f.guardians&&p.name===f.name&&CHILD_KINDS.every(k=>p.children[k.key]===f.children[k.key]);
export function partyText(t:Ticket){
  const kids=t.children&&childTotal(t.children)?`子ども ${t.party_size}名（${childSummary(t.children)}）`:`${t.party_size}名`;
  return t.guardians?`${kids}・保護者 ${t.guardians}名`:kids;
}

function minutesUntil(iso:string,now:number){return Math.max(1,Math.ceil((Date.parse(iso)-now)/60000));}
function roundNote(r:PublicRound,now:number){
  if(r.status==='before'){const m=minutesUntil(r.opens_at,now);return `${r.opens_time} から受付を開始します（あと約${m>=60?`${Math.floor(m/60)}時間${m%60?`${m%60}分`:''}`:`${m}分`}）。`;}
  if(r.status==='paused')return '受付を一時停止しています。しばらくしてから画面を更新してください。';
  if(r.status==='full')return '満員になりました。取消が出ると、再び受け付けます。';
  if(r.status==='closed')return '受付は終了しました。';
  if(r.status==='finished')return 'この回は終了しました。';
  return '';
}

export default function Visitor({page}:{page:'home'|'ticket'}){
  const [state,setState]=useState<PublicState|null>(null);
  const [offset,setOffset]=useState(0),[now,setNow]=useState(Date.now());
  const [saved,setSaved]=useState<Saved[]>([]),[tickets,setTickets]=useState<Ticket[]>([]);
  const [connection,setConnection]=useState<'loading'|'ok'|'error'>('loading');
  const [storageError,setStorageError]=useState(false);
  const [form,setForm]=useState<Form|null>(null);
  const [cancelTarget,setCancelTarget]=useState<Ticket|null>(null),[linkTarget,setLinkTarget]=useState<Ticket|null>(null);
  const [checked,setChecked]=useState<'pending'|'ok'|'failed'>('pending');
  const [pending,setPending]=useState<Pending|null>(null);
  const [busy,setBusy]=useState(false),[issuing,setIssuing]=useState(false),[highlight,setHighlight]=useState<string|null>(null);
  const [toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
  const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null),savedRef=useRef<Saved[]>([]),busyRef=useRef(false);

  const notify=useCallback((text:string,error=false)=>{setToast({text,error});if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),error?9000:5000);},[]);
  const persist=useCallback((list:Saved[])=>{savedRef.current=list;setSaved(list);try{localStorage.setItem(TICKETS_KEY,JSON.stringify(list));}catch{setStorageError(true);}},[]);

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

  function addTicket(t:Ticket){
    const token=t.token??savedRef.current.find(s=>s.id===t.id)?.token;
    if(!token)return;
    const next=[...savedRef.current.filter(s=>s.id!==t.id),{id:t.id,token,ticket:{...t,token}}];
    persist(next);setTickets(cachedTickets(next));
  }
  function savePending(p:Pending|null){
    setPending(p);
    try{if(p)localStorage.setItem(PENDING_KEY,JSON.stringify(p));else localStorage.removeItem(PENDING_KEY);}catch{setStorageError(true);}
  }

  useEffect(()=>{
    let list:Saved[]=[],p:Pending|null=null;
    try{
      deviceId();
      const raw=load<Saved[]>(TICKETS_KEY,[]);
      list=(Array.isArray(raw)?raw:[]).map(validSaved).filter((s):s is Saved=>!!s);
      p=load<Pending|null>(PENDING_KEY,null);
    }catch{setStorageError(true);}
    const linked=takeLink(list);
    list=linked.list;
    if(linked.id){setHighlight(linked.id);try{localStorage.setItem(TICKETS_KEY,JSON.stringify(list));}catch{setStorageError(true);}}
    savedRef.current=list;setSaved(list);setTickets(cachedTickets(list));
    if(p?.requestId&&p.children&&typeof p.name==='string')setPending(p);else if(p){try{localStorage.removeItem(PENDING_KEY);}catch{}}
    refreshRounds();refreshTickets(list);
    const poll=setInterval(()=>{if(document.visibilityState==='visible'&&!busyRef.current){refreshRounds();refreshTickets();}},10000);
    const tick=setInterval(()=>setNow(Date.now()),1000);
    const visible=()=>{if(document.visibilityState==='visible'){refreshRounds();refreshTickets();}};
    const hash=()=>{const l=takeLink(savedRef.current);if(l.id){persist(l.list);setTickets(cachedTickets(l.list));setHighlight(l.id);refreshTickets(l.list);}};
    document.addEventListener('visibilitychange',visible);window.addEventListener('hashchange',hash);
    return()=>{clearInterval(poll);clearInterval(tick);document.removeEventListener('visibilitychange',visible);window.removeEventListener('hashchange',hash);if(toastTimer.current)clearTimeout(toastTimer.current);};
  },[refreshRounds,refreshTickets,persist]);

  useEffect(()=>{
    if(page!=='ticket'||!highlight)return;
    const timer=setTimeout(()=>document.getElementById(`ticket-${highlight}`)?.scrollIntoView({behavior:'smooth',block:'center'}),80);
    return()=>clearTimeout(timer);
  },[page,highlight,tickets.length]);

  const serverNow=now+offset;
  const activeTickets=tickets.filter(t=>t.status==='active'&&!t.round_finished);
  const mine=(roundId:number)=>tickets.find(t=>t.round_id===roundId&&t.status==='active');

  async function issue(f:Form){
    if(busyRef.current)return;
    const guardians=needsGuardian(f.children)?f.guardians:0,name=f.name.trim();
    const op:Pending=pending&&sameParty(pending,{...f,guardians,name})?pending:{requestId:newId(),roundId:f.round.id,children:f.children,guardians,name};
    let device:string;
    try{device=deviceId();localStorage.setItem(PENDING_KEY,JSON.stringify(op));localStorage.setItem(NAME_KEY,name);setPending(op);}
    catch{setStorageError(true);notify('このブラウザーでは整理券を保存できないため、申し込みを止めました。',true);return;}
    busyRef.current=true;setBusy(true);setIssuing(true);
    try{
      const r=await (await backend()).issue({roundId:op.roundId,children:op.children,guardians:op.guardians,name:op.name,deviceId:device,requestId:op.requestId});
      addTicket(r.ticket);savePending(null);setForm(null);setHighlight(r.ticket.id);
      notify(`${r.ticket.round_label}の整理券（No.${r.ticket.number}）を取りました。`);
      location.hash='#/ticket';
      refreshRounds();
    }catch(e){
      const err=e instanceof ApiError?e:new ApiError('処理を完了できませんでした。',0,'network');
      if(err.code==='network'||err.status>=500){notify('通信が途中で途切れました。下の「結果を確認する」を押してください。',true);setForm(null);}
      else{savePending(null);setForm(null);notify(err.message,true);if(err.code==='already')refreshTickets();}
      refreshRounds();
    }finally{busyRef.current=false;setBusy(false);setIssuing(false);}
  }

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
    <a className="v-brand" href="#/"><span className="brand-icon small"><TicketIcon size={20} strokeWidth={1.8}/></span><span><strong>{content.eventName}</strong><small>{content.performanceName} 整理券</small></span></a>
    <span className="v-clock" aria-label="現在時刻"><Clock3 size={14}/>{clockSeconds(serverNow)}</span>
  </header>;

  const banners=<>
    {storageError&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>このブラウザーでは整理券を保存できません</strong><p>シークレットモードやプライベートブラウズを解除してから、もう一度開いてください。</p></div></div>}
    {connection==='error'&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>通信を確認できません</strong><p>{MODE==='supabase'?'インターネットにつながっているか確かめてください。':'会場のWi-Fiにつながっているか確かめてください。'}取った整理券はこのスマホに保存されています。</p></div><button className="button small" onClick={()=>{refreshRounds();refreshTickets();}}><RefreshCw size={15}/>再読み込み</button></div>}
    {pending&&!issuing&&<div className="banner warning"><Clock3 size={20}/><div><strong>前回の申し込み結果を確認できていません</strong><p>整理券が発行されたかどうかを確かめます。何度も申し込む必要はありません。</p><div className="pending-actions"><button className="button small primary" disabled={busy} onClick={resolvePending}>{busy?<RefreshCw size={15} className="spin"/>:<CheckCircle2 size={15}/>}結果を確認する</button></div></div></div>}
  </>;

  if(page==='ticket')return <div className="v-shell">
    {header}
    <main className="v-main">
      <a className="back-link" href="#/"><ArrowLeft size={17}/>回の一覧へ戻る</a>
      <h1 className="v-title">あなたの整理券</h1>
      {banners}
      {checked==='failed'&&tickets.length>0&&<div className="banner warning"><Clock3 size={20}/><div><strong>前回確認した内容を表示しています</strong><p>通信がつながると、自動で最新の状態に更新します。</p></div></div>}
      {!tickets.length&&saved.length>0&&checked==='pending'&&<div className="table-loading"><RefreshCw size={16} className="spin"/>整理券を確認しています</div>}
      {!tickets.length&&saved.length>0&&checked==='failed'&&<div className="v-empty"><TriangleAlert size={36} strokeWidth={1.4}/><strong>整理券を表示できませんでした</strong><p>通信がつながると表示されます。電波の良い場所で「再読み込み」を押してください。</p></div>}
      {!tickets.length&&(!saved.length||checked==='ok')&&<div className="v-empty"><TicketIcon size={36} strokeWidth={1.4}/><strong>整理券はまだありません</strong><p>回の一覧から、整理券を取ってください。別のブラウザーで取った場合は、そのとき保存した「整理券のリンク」を開いてください。</p><a className="button primary" href="#/">回の一覧へ<ChevronRight size={16}/></a></div>}
      <div className="ticket-list">{tickets.map(t=><TicketCard key={t.id} t={t} now={serverNow} highlight={t.id===highlight} onCancel={()=>setCancelTarget(t)} onLink={()=>setLinkTarget(t)}/>)}</div>
      {tickets.length>0&&<p className="v-hint"><Info size={14}/>入場時にこの画面をスタッフに見せてください。時刻が動いていることを確認します。</p>}
      {tickets.some(t=>t.status==='active'&&!t.round_finished)&&<p className="v-hint"><Info size={14}/>整理券は、いま開いているブラウザーに保存されています。QRコードを別のアプリで読むと表示されないことがあるので、「整理券のリンクを保存」からリンクを残しておくと安心です。</p>}
    </main>
    <footer className="v-footer">{content.footer}</footer>
    {cancelTarget&&<Dialog title="整理券を取り消す" busy={busy} onClose={()=>setCancelTarget(null)}>
      <span className="dialog-symbol red"><TriangleAlert size={24}/></span>
      <h2>整理券を取り消しますか？</h2>
      <p className="dialog-description">{cancelTarget.round_label}（開演 {cancelTarget.starts_time}）の No.{cancelTarget.number}・{partyText(cancelTarget)} を取り消します。取り消した整理券は元に戻せません。</p>
      <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setCancelTarget(null)}>やめる</button><button className="button destructive" disabled={busy} onClick={()=>cancel(cancelTarget)}>{busy&&<RefreshCw size={16} className="spin"/>}取り消す</button></div>
    </Dialog>}
    {linkTarget&&<LinkDialog t={linkTarget} notify={notify} onClose={()=>setLinkTarget(null)}/>}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;

  return <div className="v-shell">
    {header}
    <main className="v-main">
      <section className="v-hero"><span className="eyebrow">NUMBERED TICKET</span><h1>{content.performanceName}の整理券</h1><p>{content.lead}</p></section>
      {banners}
      {activeTickets.length>0&&<a className="mine-strip" href="#/ticket"><TicketIcon size={20}/><span><strong>整理券を {activeTickets.length} 枚お持ちです</strong><small>タップして表示します</small></span><ChevronRight size={18}/></a>}
      <section className="panel notices"><h2><Info size={17}/>ご注意</h2><ul>{content.notices.map(n=><li key={n}>{n}</li>)}</ul></section>
      <h2 className="v-section-title">回の一覧<span>{state?dateLabel(serverNow):''}</span></h2>
      {!state&&connection==='loading'&&<div className="table-loading"><RefreshCw size={16} className="spin"/>読み込み中</div>}
      {state&&!state.rounds.length&&<div className="v-empty"><Clock3 size={32} strokeWidth={1.4}/><strong>まだ回が登録されていません</strong><p>しばらくしてから、もう一度開いてください。</p></div>}
      <div className="round-list">{state?.rounds.map(r=>{
        const owned=mine(r.id);
        return <article key={r.id} className={`round-card ${r.status==='finished'?'finished':''}`}>
          <div className="round-head"><span className={`round-tone ${tone(r.id)}`}/><div><h3>{r.label}</h3><p>開演 <strong>{r.starts_time}</strong></p></div><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span></div>
          <dl className="round-meta"><div><dt>受付時間</dt><dd>{r.opens_time}〜{r.closes_time}</dd></div><div><dt>残り</dt><dd className={r.remaining>0&&r.remaining<=Math.max(5,r.capacity_people*0.1)?'low':''}>{r.status==='finished'?'—':`${r.remaining} 名`}<small> / {r.capacity_people} 名</small></dd></div></dl>
          {owned?<a className="button full" href="#/ticket" onClick={()=>setHighlight(owned.id)}><TicketIcon size={17}/>整理券を見る（No.{owned.number}）</a>
          :r.status==='open'?<button className="button primary full" disabled={busy||storageError||!!pending} onClick={()=>setForm({round:r,children:emptyChildren(),guardians:1,name:savedName()})}><TicketIcon size={17}/>整理券を取る</button>
          :<p className="round-note">{roundNote(r,serverNow)}</p>}
          {r.status==='open'&&!owned&&<p className="round-sub">1枚で子ども最大 {r.max_party} 名まで申し込めます。未就学児・小学生は、保護者の方も一緒に入場できます（定員には数えません）。</p>}
        </article>;
      })}</div>
    </main>
    <footer className="v-footer">{content.footer}</footer>
    {form&&(()=>{
      const round=state?.rounds.find(x=>x.id===form.round.id)??form.round;
      const total=childTotal(form.children),max=Math.max(0,Math.min(round.max_party,round.remaining)),guardian=needsGuardian(form.children);
      const nameOk=form.name.trim().length>0&&[...form.name.trim()].length<=MAX_NAME;
      const setKind=(key:keyof Children,value:number)=>setForm({...form,children:{...form.children,[key]:value}});
      return <Dialog title="整理券を取る" busy={busy} onClose={()=>setForm(null)}>
        <span className="dialog-symbol"><TicketIcon size={24}/></span>
        <h2>{round.label}（開演 {round.starts_time}）</h2>
        <label className="name-field"><span>お名前<small>代表者の方のお名前</small></span><input type="text" autoComplete="name" maxLength={MAX_NAME} placeholder="例: 紅華 花子" value={form.name} disabled={busy} onChange={e=>setForm({...form,name:e.target.value})}/></label>
        <p className="dialog-description">入場するお子さまの人数を、区分ごとに選んでください。1枚で子ども {round.max_party} 名まで、残りは {round.remaining} 名分です。</p>
        <div className="party-form">
          {CHILD_KINDS.map(k=><Stepper key={k.key} label={k.label} value={form.children[k.key]} min={0} canAdd={total<max} disabled={busy} onChange={v=>setKind(k.key,v)}/>)}
          {guardian&&<div className="party-guardian">
            <Stepper label="保護者" note="定員には数えません" value={form.guardians} min={0} canAdd={form.guardians<MAX_GUARDIANS} disabled={busy} onChange={v=>setForm({...form,guardians:v})}/>
            <p>未就学児・小学生と一緒に入場する保護者の人数です。</p>
          </div>}
        </div>
        {!form.name.trim()&&<p className="name-hint">お名前を入力すると、整理券を取れます。</p>}
        <div className="confirm-values"><div className="emphasis"><span>子ども</span><strong>{total} 名</strong></div>{guardian&&<div><span>保護者</span><strong>{form.guardians} 名</strong></div>}</div>
        <p className="dialog-description">整理券はこのスマホに保存されます。1つの回につき1枚までです。</p>
        <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setForm(null)}>戻る</button><button className="button primary" disabled={busy||total<1||total>max||!nameOk} onClick={()=>issue({...form,round})}>{busy?<RefreshCw size={16} className="spin"/>:<Users size={16}/>}整理券を取る</button></div>
      </Dialog>;
    })()}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;
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

function TicketCard({t,now,highlight,onCancel,onLink}:{t:Ticket;now:number;highlight:boolean;onCancel:()=>void;onLink:()=>void}){
  const live=t.status==='active'&&!t.round_finished;
  return <article id={`ticket-${t.id}`} className={`ticket-card ${tone(t.round_id)} ${t.status==='cancelled'?'cancelled':''} ${t.round_finished?'finished':''} ${highlight?'highlight':''}`}>
    <div className="ticket-band"><span>{content.eventName} {content.performanceName}</span><span>整理券</span></div>
    <div className="ticket-body">
      <div className="ticket-round"><strong>{t.round_label}</strong><span>開演 {t.starts_time}</span></div>
      <div className="ticket-number"><span>No.</span>{t.number}</div>
      {t.name&&<div className="ticket-name">{t.name} 様</div>}
      <div className="ticket-party"><Users size={20}/>{t.children&&childTotal(t.children)?<>子ども {t.party_size} 名{t.guardians?<span className="ticket-guardians">＋保護者 {t.guardians} 名</span>:null}</>:<>{t.party_size} 名</>}</div>
      {t.children&&childTotal(t.children)>0&&<div className="ticket-kinds">{childSummary(t.children).replace(/(\d+)/g,' $1名')}</div>}
      {live&&<div className="ticket-live" aria-label="現在時刻"><span className="live-dot"/>{dateLabel(now)}<strong>{clockSeconds(now)}</strong></div>}
      {t.status==='cancelled'&&<div className="ticket-state">{t.cancelled_by==='staff'?'スタッフにより取り消された整理券です':'取り消した整理券です'}</div>}
      {t.status==='active'&&t.round_finished&&<div className="ticket-state">この回は終了しました</div>}
    </div>
    {t.status==='active'&&!t.round_finished&&t.token&&<div className="ticket-foot ticket-link"><button className="text-link" onClick={onLink}><Link2 size={14}/>整理券のリンクを保存（別のブラウザー用）</button></div>}
    {t.status==='active'&&!t.round_finished&&<div className="ticket-foot">{t.cancellable?<button className="text-link danger-link" onClick={onCancel}>この整理券を取り消す</button>:<span>開演時刻を過ぎたため、取り消しはできません</span>}</div>}
    <div className="ticket-shine" aria-hidden="true"/>
  </article>;
}
