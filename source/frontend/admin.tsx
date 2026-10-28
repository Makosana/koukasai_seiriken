import {useCallback,useEffect,useRef,useState,type CSSProperties,type FormEvent,type ReactNode} from 'react';
import {Ticket as TicketIcon,CalendarClock,ListOrdered,ChartNoAxesCombined,ChartColumn,QrCode,ScanQrCode,Plus,Pencil,Trash2,Pause,Play,RefreshCw,Search,TriangleAlert,ChevronRight,Download,Printer,KeyRound,PanelLeftClose,PanelLeftOpen,ShieldCheck,Wifi,DatabaseBackup,LockKeyhole,Users,XCircle,ExternalLink,LogOut,Cloud,CircleCheck,MapPin,Hourglass,Layers,CopyPlus} from 'lucide-react';
import {ApiError,fmt} from './lib/api';
import {backend,MODE} from './lib/backend';
import type {AdminRound,AdminState,AdminTicket,AdminWaitEntry,EventInfo} from './lib/types';
import {STATUS_LABELS,WAIT_LABELS,childSummary} from './lib/types';
import {content} from './content';
import {Dialog,Toast,useQr} from './ui';
import {tone,partyText} from './visitor';
import CheckinTab from './checkin';

type Tab='rounds'|'checkin'|'tickets'|'summary'|'poster';
type RoundForm={id?:number;eventId:string;label:string;startsTime:string;opensTime:string;closesTime:string;capacity:string;maxParty:string;finishAfterMinutes:string;durationMinutes:string};
type EventForm={id?:number;label:string;venue:string;notice:string};
const CHECKIN=MODE==='supabase',WAITLIST=MODE==='supabase';
const tabs=[{id:'rounds' as Tab,label:'イベントと回',icon:CalendarClock},...(CHECKIN?[{id:'checkin' as Tab,label:'入場受付',icon:ScanQrCode}]:[]),{id:'tickets' as Tab,label:'整理券の一覧',icon:ListOrdered},{id:'summary' as Tab,label:'集計・出力',icon:ChartNoAxesCombined},{id:'poster' as Tab,label:'掲示用QR',icon:QrCode}];
const titles:Record<Tab,{title:string;subtitle:string;kicker:string}>={
  rounds:{title:'イベントと回',subtitle:'イベント（会場）を登録し、イベントごとに回の定員と受付時間を登録します。受付は時間になると自動で始まり、満員か終了時刻で締め切ります。',kicker:'EVENTS & ROUNDS'},
  checkin:{title:'入場受付',subtitle:'iPadなどのカメラで来場者の整理券のQRコードを読み取ると、受付済みになります。',kicker:'CHECK-IN'},
  tickets:{title:'整理券の一覧',subtitle:WAITLIST?'入場口で番号を照合したり、疑わしい整理券を取り消したりできます。回ごとのキャンセル待ちもここで確認できます。':'入場口で番号を照合したり、疑わしい整理券を取り消したりできます。',kicker:'TICKETS'},
  summary:{title:'集計・出力',subtitle:'配布した枚数と人数を確認し、CSVで記録を残します。',kicker:'SUMMARY'},
  poster:{title:'掲示用QR',subtitle:'会場に貼るQRコードを表示・印刷します。',kicker:'POSTER'}
};
const tabFromHash=():Tab=>CHECKIN&&location.hash==='#/admin/checkin'?'checkin':'rounds';
const WIFI_KEY='seiriken-admin-wifi-v1';
const time=(iso:string)=>new Date(iso).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const isTime=(v:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isCount=(v:string,min:number,max:number)=>/^\d+$/.test(v)&&Number(v)>=min&&Number(v)<=max;
function emptyForm(eventId:number|undefined,last?:AdminRound):RoundForm{
  const ev=eventId?String(eventId):'';
  if(!last)return {eventId:ev,label:'',startsTime:'10:00',opensTime:'09:00',closesTime:'10:00',capacity:'100',maxParty:'4',finishAfterMinutes:'30',durationMinutes:'30'};
  return {eventId:ev,label:'',startsTime:last.starts_time,opensTime:last.opens_time,closesTime:last.closes_time,capacity:String(last.capacity_people),maxParty:String(last.max_party),finishAfterMinutes:String(last.finish_after_minutes),durationMinutes:String(last.duration_minutes)};
}
const roundForm=(r:AdminRound):RoundForm=>({id:r.id,eventId:String(r.event_id??''),label:r.label,startsTime:r.starts_time,opensTime:r.opens_time,closesTime:r.closes_time,capacity:String(r.capacity_people),maxParty:String(r.max_party),finishAfterMinutes:String(r.finish_after_minutes),durationMinutes:String(r.duration_minutes)});
const eventName=(events:EventInfo[],id:number)=>events.find(e=>e.id===id)?.label??'';

type BulkForm={eventId:string;firstStart:string;lastStart:string;interval:string;opensBefore:string;closesBefore:string;capacity:string;maxParty:string;durationMinutes:string;finishAfterMinutes:string};
type BulkRow={label:string;starts:string;ends:string;opens:string;closes:string;skip:boolean;overlap:boolean};
const BULK_MAX=50;
const toMin=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
const fromMin=(m:number)=>`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
function bulkForm(eventId:number|undefined,last?:AdminRound):BulkForm{
  const base={eventId:eventId?String(eventId):'',firstStart:'10:00',lastStart:'15:00',interval:'60',opensBefore:'60',closesBefore:'0',capacity:'100',maxParty:'4',durationMinutes:'30',finishAfterMinutes:'30'};
  if(!last)return base;
  const s=toMin(last.starts_time);
  return {...base,opensBefore:String(Math.max(0,s-toMin(last.opens_time))),closesBefore:String(Math.max(0,s-toMin(last.closes_time))),capacity:String(last.capacity_people),maxParty:String(last.max_party),durationMinutes:String(last.duration_minutes),finishAfterMinutes:String(last.finish_after_minutes)};
}
// 同じイベントにすでにある開演時刻はとばすので、途中で止まっても押し直せば残りだけが追加される
function bulkPlan(f:BulkForm,rounds:AdminRound[]):{rows:BulkRow[];error:string;outOfOrder?:boolean}{
  const fail=(error:string)=>({rows:[],error});
  if(!f.eventId)return fail('イベントを選んでください。');
  if(!isTime(f.firstStart)||!isTime(f.lastStart))return fail('開演の時刻は「10:00」の形式で入力してください。');
  if(!isCount(f.interval,5,600))return fail('間隔は5〜600分で入力してください。');
  if(!isCount(f.opensBefore,0,1440)||!isCount(f.closesBefore,0,1440))return fail('受付の時間は、開演の0〜1440分前で入力してください。');
  if(!isCount(f.capacity,1,10000)||!isCount(f.maxParty,1,20)||!isCount(f.finishAfterMinutes,0,600)||!isCount(f.durationMinutes,1,600))return fail('定員は1〜10000、1枚あたりの人数は1〜20、上演時間は1〜600分、終了扱いまでの時間は0〜600分で入力してください。');
  const first=toMin(f.firstStart),last=toMin(f.lastStart),step=Number(f.interval),before=Number(f.opensBefore),until=Number(f.closesBefore),duration=Number(f.durationMinutes);
  if(last<first)return fail('最後の開演は、最初の開演と同じか、それより後の時刻にしてください。');
  if(before<=until)return fail('受付開始は受付終了より前にしてください（「何分前から」を「何分前まで」より大きくします）。');
  const count=Math.floor((last-first)/step)+1;
  if(count>BULK_MAX)return fail(`一度に追加できるのは${BULK_MAX}回までです（いまの設定では${count}回）。間隔か時刻を見直してください。`);
  if(first-before<0)return fail(`最初の回（${f.firstStart}）の受付開始が0:00より前になります。「何分前から」を短くしてください。`);
  const mine=rounds.filter(r=>r.event_id===Number(f.eventId));
  const taken=new Set(mine.map(r=>r.starts_time));
  const numbers=mine.map(r=>/^第(\d+)回$/.exec(r.label)?.[1]).filter((n):n is string=>!!n).map(Number);
  let next=(numbers.length?Math.max(...numbers):mine.length)+1;
  const rows:BulkRow[]=[];
  for(let i=0;i<count;i++){
    const s=first+i*step,starts=fromMin(s),skip=taken.has(starts);
    rows.push({label:skip?'':`第${next++}回`,starts,ends:fromMin(s+duration),opens:fromMin(s-before),closes:fromMin(s-until),skip,overlap:false});
  }
  const spans=[...mine.map(r=>[toMin(r.starts_time),toMin(r.starts_time)+r.duration_minutes]),...rows.filter(r=>!r.skip).map(r=>[toMin(r.starts),toMin(r.starts)+duration])];
  for(const r of rows){
    if(r.skip)continue;
    const a=toMin(r.starts),b=a+duration;
    r.overlap=spans.filter(([x,y])=>x<b&&a<y).length>1;
  }
  const latest=mine.reduce((m,r)=>Math.max(m,toMin(r.starts_time)),-1);
  return {rows,error:'',outOfOrder:rows.some(r=>!r.skip&&toMin(r.starts)<latest)};
}
function wifiEscape(s:string){return s.replace(/([\\;,:"])/g,'\\$1');}

export default function Admin(){
  const [state,setState]=useState<AdminState|null>(null);
  const [auth,setAuth]=useState<'checking'|'ok'|'login'>('checking');
  const [connection,setConnection]=useState<'loading'|'ok'|'error'>('loading');
  const [tab,setTab]=useState<Tab>(tabFromHash),[navOpen,setNavOpen]=useState(false);
  const [busy,setBusy]=useState(false),[toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
  const [code,setCode]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[loginError,setLoginError]=useState('');
  const [form,setForm]=useState<RoundForm|null>(null),[formError,setFormError]=useState('');
  const [bulk,setBulk]=useState<BulkForm|null>(null);
  const [deleteTarget,setDeleteTarget]=useState<AdminRound|null>(null);
  const [eventForm,setEventForm]=useState<EventForm|null>(null),[eventDelete,setEventDelete]=useState<EventInfo|null>(null);
  const [eventFilter,setEventFilter]=useState<number|null>(null);
  const [waitList,setWaitList]=useState<AdminWaitEntry[]>([]);
  const [dateDraft,setDateDraft]=useState('');
  const [ticketRound,setTicketRound]=useState<number|'all'|null>(null),[numberDraft,setNumberDraft]=useState(''),[numberQuery,setNumberQuery]=useState('');
  const [list,setList]=useState<AdminTicket[]>([]),[listBusy,setListBusy]=useState(false),[cancelTarget,setCancelTarget]=useState<AdminTicket|null>(null);
  const [cancelPassword,setCancelPassword]=useState('');
  const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null),listSerial=useRef(0);

  const notify=useCallback((text:string,error=false)=>{setToast({text,error});if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),error?9000:5000);},[]);
  const refresh=useCallback(async()=>{
    try{const s=await (await backend()).adminState();setState(s);setAuth('ok');setConnection('ok');return s;}
    catch(e){if(e instanceof ApiError&&e.status===401){setAuth('login');setConnection('ok');}else setConnection('error');return null;}
  },[]);
  useEffect(()=>{
    refresh();
    const poll=setInterval(()=>{if(document.visibilityState==='visible')refresh();},5000);
    return()=>{clearInterval(poll);if(toastTimer.current)clearTimeout(toastTimer.current);};
  },[refresh]);
  useEffect(()=>{if(state&&!dateDraft)setDateDraft(state.eventDate);},[state,dateDraft]);
  useEffect(()=>{if(state&&ticketRound===null&&state.rounds.length)setTicketRound((state.rounds.find(r=>r.status!=='finished')??state.rounds[0]).id);},[state,ticketRound]);

  const loadTickets=useCallback(async()=>{
    if(ticketRound===null)return;
    const serial=++listSerial.current;setListBusy(true);
    try{const tickets=await (await backend()).listTickets(ticketRound==='all'?null:ticketRound,numberQuery);if(serial===listSerial.current)setList(tickets);}
    catch(e){if(serial===listSerial.current){setList([]);notify(e instanceof Error?e.message:'一覧を読み込めません。',true);}}
    finally{if(serial===listSerial.current)setListBusy(false);}
  },[ticketRound,numberQuery,notify]);
  const watchedRounds=state?.rounds.filter(r=>ticketRound==='all'||r.id===ticketRound)??[];
  const ticketChanges=watchedRounds.map(r=>`${r.last_number}/${r.cancelled_count}/${r.checked_in_count??0}`).join(',');
  const waitingCount=state?.rounds.find(r=>r.id===ticketRound)?.waiting_count;
  const lastNumber=state?.rounds.find(r=>r.id===ticketRound)?.last_number;
  useEffect(()=>{if(tab==='tickets')loadTickets();},[tab,loadTickets,ticketChanges]);
  useEffect(()=>{
    if(tab!=='tickets'||!WAITLIST||typeof ticketRound!=='number')return;
    let live=true;
    backend().then(b=>b.listWaitlist(ticketRound)).then(x=>{if(live)setWaitList(x);}).catch(()=>{if(live)setWaitList([]);});
    return()=>{live=false;};
  },[tab,ticketRound,waitingCount,lastNumber]);

  async function login(e:FormEvent){
    e.preventDefault();setBusy(true);setLoginError('');
    try{await (await backend()).login(MODE==='supabase'?{email:email.trim(),password}:{code:code.trim()});setCode('');setPassword('');await refresh();}
    catch(err){setLoginError(err instanceof Error?err.message:'確認できませんでした。');}
    finally{setBusy(false);}
  }
  async function logout(){
    setBusy(true);
    try{await (await backend()).logout();}catch{}
    finally{setBusy(false);setState(null);setAuth('login');}
  }
  async function operate(body:Record<string,unknown>,done:string){
    setBusy(true);
    try{await (await backend()).adminOperation(body);notify(done);await refresh();return true;}
    catch(e){const message=e instanceof Error?e.message:'保存できませんでした。';if(e instanceof ApiError&&e.status===401)setAuth('login');notify(message,true);return false;}
    finally{setBusy(false);}
  }
  async function saveForm(){
    if(!form)return;
    const label=form.label.trim()||`${form.startsTime}の回`;
    if(![form.startsTime,form.opensTime,form.closesTime].every(isTime)){setFormError('時刻は「10:00」の形式で入力してください。');return;}
    if(form.opensTime>=form.closesTime){setFormError('受付終了時刻は受付開始時刻より後にしてください。');return;}
    if(!form.eventId){setFormError('イベントを選んでください。');return;}
    if(!isCount(form.capacity,1,10000)||!isCount(form.maxParty,1,20)||!isCount(form.finishAfterMinutes,0,600)||!isCount(form.durationMinutes,1,600)){setFormError('定員は1〜10000、1枚あたりの人数は1〜20、上演時間は1〜600分、終了扱いまでの時間は0〜600分で入力してください。');return;}
    setFormError('');
    const ok=await operate({action:form.id?'update':'create',id:form.id,eventId:Number(form.eventId),label,startsTime:form.startsTime,opensTime:form.opensTime,closesTime:form.closesTime,capacity:Number(form.capacity),maxParty:Number(form.maxParty),finishAfterMinutes:Number(form.finishAfterMinutes),durationMinutes:Number(form.durationMinutes)},form.id?'回を更新しました。':'回を追加しました。');
    if(ok)setForm(null);
  }
  async function saveBulk(){
    if(!bulk)return;
    const plan=bulkPlan(bulk,state?.rounds??[]);
    if(plan.error){setFormError(plan.error);return;}
    const todo=plan.rows.filter(r=>!r.skip);
    if(!todo.length)return;
    setFormError('');setBusy(true);
    let added=0;
    try{
      const b=await backend();
      for(const r of todo){
        await b.adminOperation({action:'create',eventId:Number(bulk.eventId),label:r.label,startsTime:r.starts,opensTime:r.opens,closesTime:r.closes,capacity:Number(bulk.capacity),maxParty:Number(bulk.maxParty),finishAfterMinutes:Number(bulk.finishAfterMinutes),durationMinutes:Number(bulk.durationMinutes)});
        added++;
      }
      notify(`${added}回を追加しました。`);setBulk(null);
    }catch(e){
      if(e instanceof ApiError&&e.status===401)setAuth('login');
      const message=e instanceof Error?e.message:'保存できませんでした。';
      setFormError(added?`${added}回を追加したところで止まりました（${message}）。もう一度追加のボタンを押すと、残りの回だけを追加します。`:message);
    }finally{setBusy(false);await refresh();}
  }
  async function saveEvent(){
    if(!eventForm)return;
    const label=eventForm.label.trim();
    if(!label){setFormError('イベントの名前を入力してください。');return;}
    setFormError('');
    const ok=await operate({action:eventForm.id?'event_update':'event_create',id:eventForm.id,label,venue:eventForm.venue.trim(),notice:eventForm.notice.trim()},eventForm.id?'イベントを更新しました。':'イベントを追加しました。');
    if(ok)setEventForm(null);
  }
  async function staffCancel(t:AdminTicket){
    setBusy(true);
    try{await (await backend()).adminCancel(t.id,t.checked_in_at?cancelPassword:undefined);notify(`${t.event_label?`${t.event_label} `:''}${t.round_label}の No.${t.number} を取り消しました。`);setCancelTarget(null);setCancelPassword('');await refresh();await loadTickets();}
    catch(e){if(e instanceof ApiError&&e.code==='password')setCancelPassword('');notify(e instanceof Error?e.message:'取り消せませんでした。',true);}
    finally{setBusy(false);}
  }
  async function downloadCsv(){
    setBusy(true);
    try{
      const {blob,filename}=await (await backend()).exportCsv();
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=filename;
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      notify(MODE==='supabase'?'整理券の記録をCSVで出力しました。':'整理券の記録をCSVで出力しました。exports フォルダーにも保存しています。');
    }catch(e){notify(e instanceof Error?e.message:'出力できませんでした。',true);}
    finally{setBusy(false);}
  }
  async function manualBackup(){
    setBusy(true);
    try{const filename=await (await backend()).backup();notify(`バックアップを作成しました：${filename}`);await refresh();}
    catch(e){notify(e instanceof Error?e.message:'バックアップを作成できませんでした。',true);}
    finally{setBusy(false);}
  }
  function chooseTab(id:Tab){
    setTab(id);setNavOpen(false);
    if(CHECKIN)history.replaceState(null,'',location.pathname+location.search+(id==='checkin'?'#/admin/checkin':'#/admin'));
  }

  if(auth==='login'&&MODE==='supabase')return <div className="login-shell"><form className="login-card" onSubmit={login}>
    <span className="brand-icon"><KeyRound size={24}/></span>
    <h1>運営画面に入る</h1>
    <p>運営スタッフ用のメールアドレスとパスワードを入力してください。</p>
    {loginError&&<p className="login-error" role="alert">{loginError}</p>}
    <input className="login-text" type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" aria-label="メールアドレス" placeholder="メールアドレス"/>
    <input className="login-text" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" aria-label="パスワード" placeholder="パスワード"/>
    <button className="button primary full" disabled={busy||!email.trim()||!password}>{busy?<RefreshCw size={16} className="spin"/>:<LockKeyhole size={16}/>}入る</button>
    <a className="text-link" href="#/">来場者向けの画面へ</a>
  </form></div>;
  if(auth==='login')return <div className="login-shell"><form className="login-card" onSubmit={login}>
    <span className="brand-icon"><KeyRound size={24}/></span>
    <h1>運営画面に入る</h1>
    <p>整理券PCの黒い画面、またはPCの運営画面に表示されている8桁のスタッフコードを入力してください。</p>
    {loginError&&<p className="login-error" role="alert">{loginError}</p>}
    <input value={code} onChange={e=>/^\d{0,8}$/.test(e.target.value)&&setCode(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={8} aria-label="スタッフコード" placeholder="00000000"/>
    <button className="button primary full" disabled={busy||code.length!==8}>{busy?<RefreshCw size={16} className="spin"/>:<LockKeyhole size={16}/>}入る</button>
    <a className="text-link" href="#/">来場者向けの画面へ</a>
  </form></div>;

  const rounds=state?.rounds??[];
  const events=state?.events??[];
  const shown=eventFilter===null?rounds:rounds.filter(r=>r.event_id===eventFilter);
  const selected=rounds.find(r=>r.id===ticketRound);
  const allTickets=ticketRound==='all';
  const eventSelect=(value:number|null,onChange:(v:number|null)=>void,all='すべてのイベント')=><select className="filter-select" value={value??''} onChange={e=>onChange(e.target.value?Number(e.target.value):null)} aria-label="イベントを選ぶ">{all&&<option value="">{all}</option>}{events.map(ev=><option key={ev.id} value={ev.id}>{ev.label}</option>)}</select>;
  const roundOptions=events.map(ev=>{const list=rounds.filter(r=>r.event_id===ev.id);return list.length?<optgroup key={ev.id} label={ev.label}>{list.map(r=><option key={r.id} value={r.id}>{r.label}（開演 {r.starts_time}）</option>)}</optgroup>:null;});
  return <div className="app-shell">
    {navOpen&&<button className="nav-scrim" onClick={()=>setNavOpen(false)} aria-label="メニューを閉じる"/>}
    <aside className={`sidebar ${navOpen?'expanded':''}`}>
      <a className="brand" href="#/admin"><span className="brand-icon"><TicketIcon size={26} strokeWidth={1.7}/></span><span><strong>紅華祭</strong><small>NUMBERED TICKETS</small></span></a>
      <div className="sidebar-label">整理券 運営</div>
      <nav>{tabs.map(t=><button key={t.id} className={`nav-item ${tab===t.id?'active':''}`} onClick={()=>chooseTab(t.id)} aria-current={tab===t.id?'page':undefined}><t.icon size={20} strokeWidth={1.7}/><span>{t.label}</span>{tab===t.id&&<span className="nav-dot"/>}</button>)}</nav>
      <div className="sidebar-bottom">
        {state?.server.staffCode&&state.server.lan&&<div className="rate-card"><KeyRound size={22}/><div><span>スタッフコード（他の端末用）</span><strong className="mono">{state.server.staffCode}</strong></div></div>}
        <a className="help-link" href="#/" target="_blank" rel="noreferrer"><ExternalLink size={16}/>来場者向けの画面を開く</a>
        {MODE==='supabase'&&<button className="help-link" onClick={logout} disabled={busy}><LogOut size={16}/>ログアウト{state?.server.staffEmail?`（${state.server.staffEmail}）`:''}</button>}
        <div className="sidebar-footer"><span className="little-dot"/>紅華祭 整理券システム<span>{MODE==='supabase'?'Online v1.0':'Local v1.0'}</span></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumbs"><button className="icon-button mobile-menu" onClick={()=>setNavOpen(!navOpen)} aria-label="メニュー">{navOpen?<PanelLeftClose size={22}/>:<PanelLeftOpen size={22}/>}</button><span>整理券 運営</span><ChevronRight size={14}/><strong>{tabs.find(t=>t.id===tab)?.label}</strong></div>
        <div className="topbar-right"><span className={`connection ${connection==='ok'?'connected':''}`}><span/>{connection==='ok'?(MODE==='supabase'?'オンライン（Supabase）':state?.server.lan?'来場者受付中（Wi-Fi公開）':'このPCのみ（準備用）'):connection==='loading'?'読み込み中':'接続を確認'}</span><span className="top-divider"/><span className="date-label mono">{state?time(state.now):'—'}</span></div>
      </header>
      <main>
        <div className="page-heading"><div><span className="eyebrow">{titles[tab].kicker}</span><h1>{titles[tab].title}</h1><p>{titles[tab].subtitle}</p></div></div>
        {connection==='error'&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>{MODE==='supabase'?'Supabaseに接続できません':'整理券PCに接続できません'}</strong><p>{MODE==='supabase'?'インターネットの接続と、Supabaseのプロジェクトが停止していないかを確認してください。':'PCの黒い画面が開いたままか確認してください。'}</p></div><button className="button small" onClick={()=>refresh()}><RefreshCw size={15}/>再接続</button></div>}
        {state?.server.backupError&&<div className="banner danger"><TriangleAlert size={20}/><div><strong>自動バックアップを確認してください</strong><p>{state.server.backupError}</p></div></div>}
        {state&&state.eventDate!==state.today&&<div className="banner warning"><CalendarClock size={20}/><div><strong>開催日が今日（{state.today}）ではありません</strong><p>受付は開催日（{state.eventDate}）の時刻で自動的に始まります。リハーサルをする場合は、開催日を今日に変えてください。</p></div></div>}
        {state&&MODE==='local'&&!state.server.lan&&tab!=='poster'&&<div className="banner setup-banner"><Wifi size={20}/><div><strong>いまは準備用の起動です</strong><p>来場者のスマホからは開けません。本番では「停止.bat」で止めてから「来場者受付用に起動.bat」で起動してください。</p></div></div>}

        {tab==='rounds'&&<>
          <section className="stats-grid" aria-label="全体の状況">
            <Stat label="受付中の回" value={rounds.filter(r=>r.status==='open').length} unit="回" icon={<Play size={18}/>} color="green" foot={`全 ${rounds.length} 回`}/>
            <Stat label="発行済み（有効）" value={state?.totals.tickets??0} unit="枚" icon={<TicketIcon size={18}/>} color="peach" foot={`子ども ${fmt(state?.totals.people??0)} 名・保護者 ${fmt(state?.totals.guardians??0)} 名`}/>
            <Stat label="残り（子ども）" value={state?.totals.remaining??0} unit="名" icon={<Users size={18}/>} color="blue" foot={`定員合計 ${fmt(state?.totals.capacity??0)} 名`}/>
            <Stat label="取消" value={state?.totals.cancelled??0} unit="枚" icon={<XCircle size={18}/>} color="purple" foot="本人とスタッフの合計"/>
          </section>
          <section className="panel date-panel"><div className="panel-heading"><h2><span className="heading-mark"/>開催日</h2><span className="muted tiny">回の時刻はこの日付で判定します</span></div>
            <div className="date-row"><input type="date" className="text-input" value={dateDraft} onChange={e=>setDateDraft(e.target.value)} aria-label="開催日"/><button className="button" disabled={busy||!dateDraft||dateDraft===state?.eventDate} onClick={()=>operate({action:'settings',eventDate:dateDraft},'開催日を保存しました。')}>保存</button>{state&&state.eventDate!==state.today&&<button className="button small" disabled={busy} onClick={()=>{setDateDraft(state.today);operate({action:'settings',eventDate:state.today},'開催日を今日にしました。');}}>今日にする</button>}</div>
          </section>
          <section className="panel"><div className="panel-heading"><h2><Layers size={18}/>イベント</h2><button className="button primary small" disabled={busy||connection!=='ok'} onClick={()=>{setFormError('');setEventForm({label:'',venue:'',notice:''});}}><Plus size={16}/>イベントを追加</button></div>
            {events.length?<div className="table-scroll"><table><thead><tr><th>イベント</th><th>会場</th><th>ご案内（来場者に表示）</th><th className="right">回</th><th className="right">操作</th></tr></thead><tbody>{events.map(ev=>{const count=rounds.filter(r=>r.event_id===ev.id).length;return <tr key={ev.id}>
              <td><span className={`round-dot ${tone(ev.id)}`}/><strong>{ev.label}</strong></td>
              <td>{ev.venue||<span className="muted">—</span>}</td>
              <td><span className="event-notice-cell">{ev.notice||<span className="muted">—</span>}</span></td>
              <td className="right mono">{count} 回</td>
              <td className="right"><div className="row-actions">
                <button className="button small" onClick={()=>setEventFilter(ev.id)}>回を見る</button>
                <button className="icon-button" disabled={busy} aria-label={`${ev.label}を編集`} onClick={()=>{setFormError('');setEventForm({id:ev.id,label:ev.label,venue:ev.venue,notice:ev.notice});}}><Pencil size={16}/></button>
                <button className="icon-button" disabled={busy||count>0} title={count>0?'回が登録されているイベントは削除できません':''} aria-label={`${ev.label}を削除`} onClick={()=>setEventDelete(ev)}><Trash2 size={16}/></button>
              </div></td>
            </tr>;})}</tbody></table></div>:<div className="empty"><div className="empty-icon"><Layers size={26}/></div><strong>まずイベントを登録してください</strong><p>「イベントを追加」から、イベントの名前と会場を登録します。回はイベントごとに登録します。</p></div>}
          </section>
          <section className="panel"><div className="panel-heading"><h2><CalendarClock size={18}/>回の一覧</h2><div className="row-actions">{events.length>1&&eventSelect(eventFilter,setEventFilter)}<button className="button primary small" disabled={busy||connection!=='ok'||!events.length} onClick={()=>{const ev=eventFilter??events[0]?.id;setFormError('');setForm(emptyForm(ev,rounds.filter(r=>r.event_id===ev).at(-1)));}}><Plus size={16}/>回を追加</button><button className="button small" disabled={busy||connection!=='ok'||!events.length} onClick={()=>{const ev=eventFilter??events[0]?.id;setFormError('');setBulk(bulkForm(ev,rounds.filter(r=>r.event_id===ev).at(-1)));}}><CopyPlus size={16}/>まとめて追加</button></div></div>
            {shown.length?<div className="table-scroll"><table><thead><tr><th>回</th><th>開演〜終演</th><th>受付時間</th><th>状態</th><th className="right">発行</th><th className="right">残り / 定員</th>{WAITLIST&&<th className="right">キャンセル待ち</th>}<th className="right">操作</th></tr></thead><tbody>{shown.map(r=><tr key={r.id} className={r.status==='finished'?'voided':''}>
              <td><span className={`round-dot ${tone(r.id)}`}/>{r.label}<span className="table-note">{eventName(events,r.event_id)}・1枚 最大{r.max_party}名・開演{r.finish_after_minutes}分後に終了扱い</span></td>
              <td className="mono">{r.starts_time}〜{r.ends_time}<span className="table-note">上演 {r.duration_minutes} 分</span></td>
              <td className="mono">{r.opens_time}〜{r.closes_time}</td>
              <td><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span>{r.paused&&r.status!=='paused'&&<span className="table-note">一時停止の設定あり</span>}</td>
              <td className="right mono">{fmt(r.active_count)} 枚<span className="table-note">子ども {fmt(r.used_people)} 名{r.used_guardians?`・保護者 ${fmt(r.used_guardians)} 名`:''}</span></td>
              <td className="right mono">{fmt(r.remaining)} / {fmt(r.capacity_people)}<div className="meter"><span style={{width:`${Math.min(100,r.used_people/r.capacity_people*100)}%`}}/></div></td>
              {WAITLIST&&<td className="right mono">{fmt(r.waiting_count)} 組<span className="table-note">{r.waitlist_enabled?`子ども ${fmt(r.waiting_people)} 名・繰り上げ ${fmt(r.promoted_count)}`:'受け付けない設定'}</span>
                <button className={`button small wait-toggle ${r.waitlist_enabled?'on':''}`} disabled={busy||r.status==='finished'} onClick={()=>operate({action:r.waitlist_enabled?'waitlist_off':'waitlist_on',id:r.id},r.waitlist_enabled?`${r.label}のキャンセル待ちの受付を止めました。`:`${r.label}のキャンセル待ちを受け付けるようにしました。`)}>{r.waitlist_enabled?'受付中':'停止中'}</button></td>}
              <td className="right"><div className="row-actions">
                {r.paused?<button className="button small" disabled={busy} onClick={()=>operate({action:'resume',id:r.id},`${r.label}の受付を再開しました。`)}><Play size={14}/>再開</button>
                :<button className="button small" disabled={busy||r.status==='finished'} onClick={()=>operate({action:'pause',id:r.id},`${r.label}の受付を一時停止しました。`)}><Pause size={14}/>一時停止</button>}
                <button className="icon-button" disabled={busy} aria-label={`${r.label}を編集`} onClick={()=>{setFormError('');setForm(roundForm(r));}}><Pencil size={16}/></button>
                <button className="icon-button" disabled={busy||r.active_count+r.cancelled_count>0} title={r.active_count+r.cancelled_count>0?'整理券を発行した回は削除できません':''} aria-label={`${r.label}を削除`} onClick={()=>setDeleteTarget(r)}><Trash2 size={16}/></button>
              </div></td>
            </tr>)}</tbody></table></div>:<div className="empty"><div className="empty-icon"><CalendarClock size={26}/></div><strong>まだ回がありません</strong><p>{events.length?'「回を追加」から、公演の回を登録してください。':'先にイベントを登録してください。'}</p></div>}
            <div className="table-bottom"><ShieldCheck size={14}/>{WAITLIST?'状態は現在時刻・残り人数・一時停止から自動で決まります。キャンセル待ちの人がいる間は、空いた席を待っている人に先に回すため「満員」のままです。':'状態は現在時刻・残り人数・一時停止から自動で決まります。'}<span>5秒ごとに更新</span></div>
          </section>
        </>}

        {tab==='tickets'&&<><section className="panel"><div className="panel-heading"><div><h2><ListOrdered size={18}/>整理券</h2>{selected&&<p className="muted tiny">有効 {fmt(selected.active_count)} 枚・子ども {fmt(selected.used_people)} 名・保護者 {fmt(selected.used_guardians??0)} 名{CHECKIN?`（うち受付済み ${fmt(selected.checked_in_count??0)} 枚）`:''}／取消 {fmt(selected.cancelled_count)} 枚／最後の番号 No.{selected.last_number}</p>}{allTickets&&state&&<p className="muted tiny">すべての回の合計：有効 {fmt(state.totals.tickets)} 枚・子ども {fmt(state.totals.people)} 名・保護者 {fmt(state.totals.guardians??0)} 名{CHECKIN?`（うち受付済み ${fmt(state.totals.checked_in??0)} 枚）`:''}／取消 {fmt(state.totals.cancelled)} 枚</p>}</div><button className="icon-button" onClick={()=>loadTickets()} aria-label="一覧を更新"><RefreshCw size={18} className={listBusy?'spin':''}/></button></div>
          <div className="history-tools">
            <select className="filter-select" value={ticketRound??''} onChange={e=>{setTicketRound(e.target.value==='all'?'all':Number(e.target.value));setNumberDraft('');setNumberQuery('');}} aria-label="回を選ぶ"><option value="all">すべてのイベント（すべての回）</option>{roundOptions}</select>
            <form className="search-field" onSubmit={e=>{e.preventDefault();setNumberQuery(numberDraft.trim());}}><Search size={18}/><input inputMode="numeric" placeholder="番号で照合（例: 23）" aria-label="番号で検索" value={numberDraft} onChange={e=>/^\d{0,6}$/.test(e.target.value)&&setNumberDraft(e.target.value)}/>{numberQuery&&<button type="button" onClick={()=>{setNumberDraft('');setNumberQuery('');}}>解除</button>}<button type="submit">照合</button></form>
          </div>
          {rounds.length?<div className="table-scroll"><table><thead><tr><th>番号</th>{allTickets&&<th>イベントと回</th>}<th>子ども</th><th>保護者</th><th>状態</th><th>発行時刻</th><th>端末</th><th className="right">操作</th></tr></thead><tbody>{list.map(t=><tr key={t.id} className={t.status==='cancelled'?'voided':''}>
            <td><strong className="ticket-no">No.{t.number}</strong></td>
            {allTickets&&<td><span className={`round-dot ${tone(t.round_id)}`}/>{t.event_label||'—'}<span className="table-note">{t.round_label}（開演 {t.starts_time}）</span></td>}
            <td className="mono">{t.party_size} 名{t.children&&childSummary(t.children)&&<span className="table-note">{childSummary(t.children)}</span>}</td>
            <td className="mono">{t.guardians?`${t.guardians} 名`:'—'}</td>
            <td>{t.status==='active'&&t.checked_in_at?<><span className="kind-pill checked">受付済み</span><span className="table-note">{time(t.checked_in_at)}</span></>:<><span className={`kind-pill ${t.status==='active'?'sale':'void'}`}>{t.status==='active'?(CHECKIN?'有効（未受付）':'有効'):t.cancelled_by==='staff'?'取消（スタッフ）':'取消（本人）'}</span>{t.cancelled_at&&<span className="table-note">{time(t.cancelled_at)}{t.checked_in_at?`（${time(t.checked_in_at)} に受付済みだった整理券）`:''}</span>}</>}</td>
            <td className="mono">{time(t.created_at)}</td>
            <td className="mono muted">{t.device}</td>
            <td className="right">{t.status==='active'&&<button className="button small void-button" disabled={busy} onClick={()=>{setCancelPassword('');setCancelTarget(t);}}>取り消す</button>}</td>
          </tr>)}</tbody></table>
          {listBusy&&!list.length&&<div className="table-loading"><RefreshCw size={16} className="spin"/>読み込み中</div>}
          {!listBusy&&!list.length&&<div className="empty"><div className="empty-icon"><TicketIcon size={26}/></div><strong>{numberQuery?`No.${numberQuery} の整理券はありません`:'まだ整理券がありません'}</strong><p>{numberQuery?(allTickets?'どの回にもこの番号の整理券はありません。存在しない番号の場合は、偽造の可能性があります。':'番号と回を確かめてください。存在しない番号の場合は、偽造の可能性があります。'):'来場者が整理券を取ると、ここに表示されます。'}</p></div>}
          </div>:<div className="empty"><strong>まだ回がありません</strong><p>「回の管理」から回を登録してください。</p></div>}
          <div className="table-bottom"><ShieldCheck size={14}/>{allTickets?'新しく発行した順に並んでいます。番号は回ごとに1番から付くので、照合するときは回も確かめてください。':'端末欄は同じスマホかどうかを見分けるための記号です。'}<span>{list.length}件を表示</span></div>
        </section>
        {WAITLIST&&selected&&<section className="panel"><div className="panel-heading"><div><h2><Hourglass size={18}/>キャンセル待ち</h2><p className="muted tiny">待っている {fmt(selected.waiting_count)} 組（子ども {fmt(selected.waiting_people)} 名）／繰り上げ {fmt(selected.promoted_count)} 件{selected.waitlist_enabled?'':'／この回は新しい登録を受け付けない設定です'}</p></div></div>
          {waitList.length?<div className="table-scroll"><table><thead><tr><th>順番</th><th>状態</th><th>子ども</th><th>保護者</th><th>登録時刻</th><th>端末</th></tr></thead><tbody>{waitList.map((w,i)=><tr key={w.id} className={w.status==='waiting'||w.status==='promoted'?'':'voided'}>
            <td className="mono">{w.status==='waiting'?<strong>{w.position} 番目</strong>:<span className="muted">{i+1}</span>}</td>
            <td><span className={`kind-pill ${w.status==='waiting'?'wait':w.status==='promoted'?'checked':'void'}`}>{WAIT_LABELS[w.status]}</span>{w.status==='promoted'&&w.ticket_number&&<span className="table-note">No.{w.ticket_number} を発行{w.ended_at?`（${time(w.ended_at)}）`:''}</span>}{w.status!=='promoted'&&w.ended_at&&<span className="table-note">{time(w.ended_at)}</span>}</td>
            <td className="mono">{w.party_size} 名{childSummary(w.children)&&<span className="table-note">{childSummary(w.children)}</span>}</td>
            <td className="mono">{w.guardians?`${w.guardians} 名`:'—'}</td>
            <td className="mono">{time(w.created_at)}</td>
            <td className="mono muted">{w.device}</td>
          </tr>)}</tbody></table></div>:<div className="empty"><strong>この回のキャンセル待ちはありません</strong><p>満員の回で来場者が登録すると、ここに順番どおり表示されます。</p></div>}
          <div className="table-bottom"><ShieldCheck size={14}/>空きが出ると、上から順に自動で整理券を発行します。先頭の人数分の空きがないときは、後ろの人も待ちます。<span>{waitList.length}件</span></div>
        </section>}
        </>}

        {tab==='checkin'&&CHECKIN&&<CheckinTab events={events} rounds={rounds} onChecked={()=>{refresh();}} onLogin={()=>setAuth('login')}/>}

        {tab==='summary'&&<>
          <section className="stats-grid">
            <Stat label="発行済み（有効）" value={state?.totals.tickets??0} unit="枚" icon={<TicketIcon size={18}/>} color="peach" foot="取消分を除く"/>
            <Stat label="入場予定（子ども）" value={state?.totals.people??0} unit="名" icon={<Users size={18}/>} color="green" foot={`このほか保護者 ${fmt(state?.totals.guardians??0)} 名`}/>
            {CHECKIN?<Stat label="受付済み（子ども）" value={state?.totals.checked_in_people??0} unit="名" icon={<CircleCheck size={18}/>} color="blue" foot={`整理券 ${fmt(state?.totals.checked_in??0)} 枚・保護者 ${fmt(state?.totals.checked_in_guardians??0)} 名`}/>
            :<Stat label="残り人数" value={state?.totals.remaining??0} unit="名" icon={<ListOrdered size={18}/>} color="blue" foot={`定員合計 ${fmt(state?.totals.capacity??0)} 名`}/>}
            {WAITLIST?<Stat label="キャンセル待ち" value={state?.totals.waiting??0} unit="組" icon={<Hourglass size={18}/>} color="purple" foot={`繰り上げ ${fmt(state?.totals.promoted??0)} 件・取消 ${fmt(state?.totals.cancelled??0)} 枚`}/>
            :<Stat label="取消" value={state?.totals.cancelled??0} unit="枚" icon={<XCircle size={18}/>} color="purple" foot="本人とスタッフの合計"/>}
          </section>
          {rounds.length>0&&<RoundChart events={events} rounds={rounds} selector={eventSelect}/>}
          <section className="panel"><div className="panel-heading"><h2><span className="heading-mark"/>回ごとの集計</h2><div className="row-actions">{events.length>1&&eventSelect(eventFilter,setEventFilter)}<button className="button small" disabled={busy} onClick={downloadCsv}><Download size={16}/>CSVを出力</button></div></div>
            <div className="table-scroll"><table><thead><tr><th>回</th><th>開演</th><th>状態</th><th className="right">有効</th><th className="right">子ども</th><th className="right">保護者</th>{CHECKIN&&<th className="right">受付済み</th>}{WAITLIST&&<th className="right">キャンセル待ち</th>}<th className="right">取消</th><th className="right">残り</th><th className="right">定員</th></tr></thead><tbody>{shown.map(r=><tr key={r.id}><td><span className={`round-dot ${tone(r.id)}`}/>{r.label}<span className="table-note">{eventName(events,r.event_id)}</span></td><td className="mono">{r.starts_time}</td><td><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span></td><td className="right mono">{fmt(r.active_count)} 枚</td><td className="right mono">{fmt(r.used_people)} 名</td><td className="right mono">{fmt(r.used_guardians??0)} 名</td>{CHECKIN&&<td className="right mono">{fmt(r.checked_in_count??0)} 枚<span className="table-note">子ども {fmt(r.checked_in_people??0)} 名・保護者 {fmt(r.checked_in_guardians??0)} 名</span></td>}{WAITLIST&&<td className="right mono">{fmt(r.waiting_count)} 組<span className="table-note">繰り上げ {fmt(r.promoted_count)} 件</span></td>}<td className="right mono">{fmt(r.cancelled_count)} 枚</td><td className="right mono">{fmt(r.remaining)} 名</td><td className="right mono">{fmt(r.capacity_people)} 名</td></tr>)}</tbody></table>{!shown.length&&<div className="empty"><strong>まだ回がありません</strong></div>}</div>
          </section>
          {MODE==='supabase'?<section className="panel backup-panel"><div className="backup-heading"><span className="backup-icon"><Cloud size={23}/></span><div><h2>記録の保存</h2><p>整理券の記録はSupabaseのデータベースに保存されます。終了後は「CSVを出力」で手元にも残してください。</p></div></div><div className="backup-buttons"><button className="button" disabled={busy} onClick={downloadCsv}><Download size={16}/>CSVを出力</button></div></section>
          :<section className="panel backup-panel"><div className="backup-heading"><span className="backup-icon"><DatabaseBackup size={23}/></span><div><h2>記録とバックアップ</h2><p>起動時・20件ごと・5分ごと（変更があれば）・終了時に、backups フォルダーへ自動で保存します。</p><small className="muted">直近の自動バックアップ：{state?.server.lastBackup?time(state.server.lastBackup):'まだありません'}{state?.server.databasePath?`　保存先：${state.server.databasePath}`:''}</small></div></div><div className="backup-buttons"><button className="button" disabled={busy} onClick={downloadCsv}><Download size={16}/>CSVを出力</button><button className="button dark" disabled={busy} onClick={manualBackup}><DatabaseBackup size={16}/>今すぐバックアップ</button></div></section>}
        </>}

        {tab==='poster'&&<PosterTab state={state}/>}
      </main>
    </div>

    {form&&<Dialog title={form.id?'回を編集':'回を追加'} busy={busy} onClose={()=>setForm(null)}>
      <span className="dialog-eyebrow">{form.id?'EDIT ROUND':'NEW ROUND'}</span>
      <h2>{form.id?'回を編集':'回を追加'}</h2>
      <p className="dialog-description">時刻は開催日（{state?.eventDate}）の時刻として扱います。</p>
      <label className="form-label" htmlFor="f-event">イベント</label>
      <select id="f-event" className="filter-select full" value={form.eventId} onChange={e=>setForm({...form,eventId:e.target.value})}>{!form.eventId&&<option value="">選んでください</option>}{events.map(ev=><option key={ev.id} value={ev.id}>{ev.label}{ev.venue?`（${ev.venue}）`:''}</option>)}</select>
      <label className="form-label" htmlFor="f-label">回の名前<span className="muted tiny">空欄なら「{form.startsTime}の回」</span></label>
      <input id="f-label" className="text-input" maxLength={40} value={form.label} placeholder={`${form.startsTime}の回`} onChange={e=>setForm({...form,label:e.target.value})}/>
      <div className="form-three">
        <div><label className="form-label" htmlFor="f-starts">開演</label><input id="f-starts" type="time" className="text-input" value={form.startsTime} onChange={e=>setForm({...form,startsTime:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-opens">受付開始</label><input id="f-opens" type="time" className="text-input" value={form.opensTime} onChange={e=>setForm({...form,opensTime:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-closes">受付終了</label><input id="f-closes" type="time" className="text-input" value={form.closesTime} onChange={e=>setForm({...form,closesTime:e.target.value})}/></div>
      </div>
      <div className="form-three">
        <div><label className="form-label" htmlFor="f-cap">定員（子ども）</label><input id="f-cap" inputMode="numeric" className="text-input" value={form.capacity} onChange={e=>/^\d{0,5}$/.test(e.target.value)&&setForm({...form,capacity:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-max">1枚の子ども上限</label><input id="f-max" inputMode="numeric" className="text-input" value={form.maxParty} onChange={e=>/^\d{0,2}$/.test(e.target.value)&&setForm({...form,maxParty:e.target.value})}/></div>
      </div>
      <div className="form-three">
        <div><label className="form-label" htmlFor="f-dur">上演時間（分）</label><input id="f-dur" inputMode="numeric" className="text-input" value={form.durationMinutes} onChange={e=>/^\d{0,3}$/.test(e.target.value)&&setForm({...form,durationMinutes:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-fin">終了扱い（開演後 分）</label><input id="f-fin" inputMode="numeric" className="text-input" value={form.finishAfterMinutes} onChange={e=>/^\d{0,3}$/.test(e.target.value)&&setForm({...form,finishAfterMinutes:e.target.value})}/></div>
      </div>
      <p className="field-hint">上演時間は、開演から終演までの長さです。1台のスマホで、開演〜終演の時間が重なる回の整理券は同時に取れません。</p>
      {form.id&&(()=>{const r=rounds.find(x=>x.id===form.id);return r&&r.used_people>0?<p className="field-hint">すでに {r.used_people} 名分を発行しています。定員はそれ以上にしてください。</p>:null;})()}
      {formError&&<p className="field-hint negative" role="alert">{formError}</p>}
      <div className="dialog-buttons spaced"><button className="button" disabled={busy} onClick={()=>setForm(null)}>やめる</button><button className="button primary" disabled={busy} onClick={saveForm}>{busy&&<RefreshCw size={16} className="spin"/>}{form.id?'更新する':'追加する'}</button></div>
    </Dialog>}

    {bulk&&(()=>{
      const plan=bulkPlan(bulk,rounds),todo=plan.rows.filter(r=>!r.skip).length,skipped=plan.rows.length-todo;
      const set=(patch:Partial<BulkForm>)=>{setBulk(b=>b&&{...b,...patch});setFormError('');};
      const num=(key:keyof BulkForm,digits:number)=>(e:{target:{value:string}})=>{if(new RegExp(`^\\d{0,${digits}}$`).test(e.target.value))set({[key]:e.target.value});};
      return <Dialog title="回をまとめて追加" busy={busy} wide onClose={()=>setBulk(null)}>
        <span className="dialog-eyebrow">NEW ROUNDS</span>
        <h2>回をまとめて追加</h2>
        <p className="dialog-description">同じ間隔で開演する回を、一度に登録します。時刻は開催日（{state?.eventDate}）の時刻として扱います。</p>
        <label className="form-label" htmlFor="b-event">イベント</label>
        <select id="b-event" className="filter-select full" value={bulk.eventId} onChange={e=>set({eventId:e.target.value})}>{!bulk.eventId&&<option value="">選んでください</option>}{events.map(ev=><option key={ev.id} value={ev.id}>{ev.label}{ev.venue?`（${ev.venue}）`:''}</option>)}</select>
        <div className="form-three">
          <div><label className="form-label" htmlFor="b-first">最初の開演</label><input id="b-first" type="time" className="text-input" value={bulk.firstStart} onChange={e=>set({firstStart:e.target.value})}/></div>
          <div><label className="form-label" htmlFor="b-last">最後の開演</label><input id="b-last" type="time" className="text-input" value={bulk.lastStart} onChange={e=>set({lastStart:e.target.value})}/></div>
          <div><label className="form-label" htmlFor="b-step">間隔（分）</label><input id="b-step" inputMode="numeric" className="text-input" value={bulk.interval} onChange={num('interval',3)}/></div>
        </div>
        <div className="bulk-presets" role="group" aria-label="よく使う間隔">{[30,45,60,90].map(m=><button key={m} type="button" className={`button small ${bulk.interval===String(m)?'on':''}`} onClick={()=>set({interval:String(m)})}>{m%60?`${m}分`:`${m/60}時間`}ごと</button>)}</div>
        <div className="form-three">
          <div><label className="form-label" htmlFor="b-before">受付開始（開演の何分前から）</label><input id="b-before" inputMode="numeric" className="text-input" value={bulk.opensBefore} onChange={num('opensBefore',4)}/></div>
          <div><label className="form-label" htmlFor="b-until">受付終了（開演の何分前まで）</label><input id="b-until" inputMode="numeric" className="text-input" value={bulk.closesBefore} onChange={num('closesBefore',4)}/></div>
        </div>
        <p className="field-hint">例：「60分前から」「0分前まで」なら、10:00開演の回は 9:00〜10:00 に整理券を配ります。</p>
        <div className="form-three">
          <div><label className="form-label" htmlFor="b-cap">定員（子ども）</label><input id="b-cap" inputMode="numeric" className="text-input" value={bulk.capacity} onChange={num('capacity',5)}/></div>
          <div><label className="form-label" htmlFor="b-max">1枚の子ども上限</label><input id="b-max" inputMode="numeric" className="text-input" value={bulk.maxParty} onChange={num('maxParty',2)}/></div>
        </div>
        <div className="form-three">
          <div><label className="form-label" htmlFor="b-dur">上演時間（分）</label><input id="b-dur" inputMode="numeric" className="text-input" value={bulk.durationMinutes} onChange={num('durationMinutes',3)}/></div>
          <div><label className="form-label" htmlFor="b-fin">終了扱い（開演後 分）</label><input id="b-fin" inputMode="numeric" className="text-input" value={bulk.finishAfterMinutes} onChange={num('finishAfterMinutes',3)}/></div>
        </div>
        <h3 className="bulk-heading">追加される回{plan.rows.length>0&&<span className="muted tiny">{todo} 回{skipped?`（すでにある ${skipped} 回はとばします）`:''}</span>}</h3>
        {plan.error?<p className="field-hint negative" role="alert">{plan.error}</p>
        :<div className="table-scroll bulk-preview"><table><thead><tr><th>回</th><th>開演〜終演</th><th>受付時間</th><th></th></tr></thead><tbody>{plan.rows.map(r=><tr key={r.starts} className={r.skip?'voided':''}>
          <td>{r.skip?<span className="muted">—</span>:r.label}</td>
          <td className="mono">{r.starts}〜{r.ends}</td>
          <td className="mono">{r.skip?'—':`${r.opens}〜${r.closes}`}</td>
          <td>{r.skip?<span className="kind-pill void">すでにあります</span>:r.overlap?<span className="kind-pill wait">時間が重なります</span>:null}</td>
        </tr>)}</tbody></table></div>}
        {!plan.error&&plan.rows.some(r=>r.overlap)&&<p className="field-hint">同じイベントの回どうしで、開演〜終演の時間が重なっています（上演時間が間隔より長いときなど）。来場者は、重なる回の整理券を同時には持てません。このままでも追加できます。</p>}
        {!plan.error&&plan.outOfOrder&&<p className="field-hint">すでにある回の続きの番号を付けるため、すでにある回より前に開演する回は、番号が開演の順になりません。気になるときは、追加したあとで回の名前を直してください。</p>}
        {formError&&formError!==plan.error&&<p className="field-hint negative" role="alert">{formError}</p>}
        <div className="dialog-buttons spaced"><button className="button" disabled={busy} onClick={()=>setBulk(null)}>やめる</button><button className="button primary" disabled={busy||!!plan.error||!todo} onClick={saveBulk}>{busy&&<RefreshCw size={16} className="spin"/>}{todo?`${todo}回を追加する`:'追加する回がありません'}</button></div>
      </Dialog>;
    })()}

    {eventForm&&<Dialog title={eventForm.id?'イベントを編集':'イベントを追加'} busy={busy} onClose={()=>setEventForm(null)}>
      <span className="dialog-eyebrow">{eventForm.id?'EDIT EVENT':'NEW EVENT'}</span>
      <h2>{eventForm.id?'イベントを編集':'イベントを追加'}</h2>
      <p className="dialog-description">来場者はイベントを選んでから、回を選びます。会場とご案内は、そのイベントのページに表示されます。</p>
      <label className="form-label" htmlFor="e-label">イベントの名前</label>
      <input id="e-label" className="text-input" maxLength={40} value={eventForm.label} placeholder="例: 吹奏楽部ミニコンサート" onChange={e=>setEventForm({...eventForm,label:e.target.value})}/>
      <label className="form-label" htmlFor="e-venue">会場</label>
      <input id="e-venue" className="text-input" maxLength={60} value={eventForm.venue} placeholder="例: 体育館" onChange={e=>setEventForm({...eventForm,venue:e.target.value})}/>
      <label className="form-label" htmlFor="e-notice">ご案内<span className="muted tiny">集合場所や持ち物など（1000文字まで）</span></label>
      <textarea id="e-notice" className="text-input textarea" maxLength={1000} rows={4} value={eventForm.notice} placeholder="例: 集合場所は体育館入口前です。開演の10分前までにお集まりください。" onChange={e=>setEventForm({...eventForm,notice:e.target.value})}/>
      {formError&&<p className="field-hint negative" role="alert">{formError}</p>}
      <div className="dialog-buttons spaced"><button className="button" disabled={busy} onClick={()=>setEventForm(null)}>やめる</button><button className="button primary" disabled={busy} onClick={saveEvent}>{busy&&<RefreshCw size={16} className="spin"/>}{eventForm.id?'更新する':'追加する'}</button></div>
    </Dialog>}

    {eventDelete&&<Dialog title="イベントを削除" busy={busy} onClose={()=>setEventDelete(null)}>
      <span className="dialog-symbol red"><Trash2 size={24}/></span>
      <h2>{eventDelete.label}を削除しますか？</h2>
      <p className="dialog-description">回が1つも登録されていないイベントだけ削除できます。</p>
      <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setEventDelete(null)}>やめる</button><button className="button destructive" disabled={busy} onClick={async()=>{if(await operate({action:'event_delete',id:eventDelete.id},'イベントを削除しました。')){setEventDelete(null);if(eventFilter===eventDelete.id)setEventFilter(null);}}}>削除する</button></div>
    </Dialog>}

    {deleteTarget&&<Dialog title="回を削除" busy={busy} onClose={()=>setDeleteTarget(null)}>
      <span className="dialog-symbol red"><Trash2 size={24}/></span>
      <h2>{deleteTarget.label}を削除しますか？</h2>
      <p className="dialog-description">整理券をまだ発行していない回だけ削除できます。</p>
      <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setDeleteTarget(null)}>やめる</button><button className="button destructive" disabled={busy} onClick={async()=>{if(await operate({action:'delete',id:deleteTarget.id},'回を削除しました。'))setDeleteTarget(null);}}>削除する</button></div>
    </Dialog>}

    {cancelTarget&&<Dialog title="整理券を取り消す" busy={busy} onClose={()=>setCancelTarget(null)}>
      <span className="dialog-symbol red"><XCircle size={24}/></span>
      <h2>No.{cancelTarget.number} を取り消しますか？</h2>
      <div className="confirm-values"><div><span>回</span><strong>{cancelTarget.event_label?`${cancelTarget.event_label} `:''}{cancelTarget.round_label}</strong></div><div><span>人数</span><strong>{partyText(cancelTarget)}</strong></div><div><span>{cancelTarget.checked_in_at?'受付時刻':'発行時刻'}</span><strong>{time(cancelTarget.checked_in_at??cancelTarget.created_at)}</strong></div></div>
      <p className="dialog-description">取り消すと、来場者のスマホにも「スタッフにより取り消された整理券」と表示されます。元に戻せません。</p>
      {cancelTarget.checked_in_at&&<>
        <p className="field-hint negative">この整理券は、すでに入場受付が済んでいます。取り消すと受付済みの人数からも外れます。取り消すには、取消用のパスワード（7桁）を入力してください。</p>
        <label className="form-label" htmlFor="cancel-password">取消用のパスワード</label>
        <input id="cancel-password" className="text-input mono" type="password" inputMode="numeric" autoComplete="off" maxLength={7} value={cancelPassword} onChange={e=>/^\d{0,7}$/.test(e.target.value)&&setCancelPassword(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&cancelPassword.length===7&&!busy)staffCancel(cancelTarget);}}/>
      </>}
      <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setCancelTarget(null)}>やめる</button><button className="button destructive" disabled={busy||(!!cancelTarget.checked_in_at&&cancelPassword.length!==7)} onClick={()=>staffCancel(cancelTarget)}>{busy&&<RefreshCw size={16} className="spin"/>}取り消す</button></div>
    </Dialog>}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;
}

function Stat({label,value,unit,icon,color,foot}:{label:string;value:number;unit:string;icon:ReactNode;color:string;foot:string}){
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><div className="stat-number">{fmt(value)}<small>{unit}</small></div><div className="stat-foot">{foot}</div></div>;
}

function RoundChart({events,rounds:all,selector}:{events:EventInfo[];rounds:AdminRound[];selector:(value:number|null,onChange:(v:number|null)=>void,all?:string)=>ReactNode}){
  const [eventId,setEventId]=useState<number|null>(null);
  const withRounds=events.filter(ev=>all.some(r=>r.event_id===ev.id));
  const current=withRounds.find(ev=>ev.id===eventId)??withRounds[0];
  const rounds=current?all.filter(r=>r.event_id===current.id):all;
  const series=[
    {label:'定員',cls:'bar-capacity',value:(r:AdminRound)=>r.capacity_people},
    {label:'整理券を取った人数',cls:'bar-issued',value:(r:AdminRound)=>r.used_people},
    ...(CHECKIN?[{label:'受付が済んだ人数',cls:'bar-checked',value:(r:AdminRound)=>r.checked_in_people??0}]:[]),
    ...(WAITLIST?[{label:'キャンセル待ちの人数',cls:'bar-waiting',value:(r:AdminRound)=>r.waiting_people??0}]:[])
  ];
  const max=Math.max(1,...rounds.flatMap(r=>series.map(s=>s.value(r))));
  return <section className="panel chart-panel">
    <div className="panel-heading"><h2><ChartColumn size={18}/>回ごとのグラフ（子どもの人数）</h2>{withRounds.length>1&&selector(current?.id??null,setEventId,'')}</div>
    <div className="chart-legend chart-legend-row">{series.map(s=><span key={s.cls}><i className={s.cls}/>{s.label}</span>)}{current?.venue&&<span className="muted"><MapPin size={12}/>{current.venue}</span>}</div>
    <div className="chart-scroll"><div className="chart" style={{'--bars':series.length} as CSSProperties}>
      {rounds.map(r=><div key={r.id} className="chart-group">
        <div className="chart-bars">{series.map(s=>{const v=s.value(r);return <div key={s.cls} className={`chart-bar ${s.cls}`} style={{height:`${v/max*100}%`}} title={`${r.label}：${s.label} ${fmt(v)} 名`}><span>{fmt(v)}</span></div>;})}</div>
        <div className="chart-label"><span className={`round-dot ${tone(r.id)}`}/><strong>{r.label}</strong><small>{r.starts_time}</small></div>
      </div>)}
    </div></div>
    <div className="table-bottom"><ShieldCheck size={14}/>保護者は定員に数えないため、グラフにも入れていません。<span>5秒ごとに更新</span></div>
  </section>;
}

function PosterTab({state}:{state:AdminState|null}){
  const urls=state?.server.lanUrls??[];
  const [base,setBase]=useState('');
  const [eventId,setEventId]=useState<number|null>(null);
  const [wifi,setWifi]=useState<{ssid:string;password:string;show:boolean}>(()=>{try{return {ssid:'',password:'',show:false,...JSON.parse(localStorage.getItem(WIFI_KEY)||'{}')};}catch{return {ssid:'',password:'',show:false};}});
  useEffect(()=>{if(urls.length&&!urls.includes(base))setBase(urls[0]);},[urls.join(','),base]);
  useEffect(()=>{try{localStorage.setItem(WIFI_KEY,JSON.stringify(wifi));}catch{}},[wifi]);
  const events=state?.events??[];
  const event=events.find(e=>e.id===eventId);
  const url=base?base+(event?`#/e/${event.id}`:''):'';
  const pageQr=useQr(url);
  const online=state?.server.mode==='supabase';
  const previewing=online&&/^(localhost|127\.|\[::1\])/.test(location.hostname);
  const wifiText=!online&&wifi.show&&wifi.ssid?`WIFI:T:${wifi.password?'WPA':'nopass'};S:${wifiEscape(wifi.ssid)};${wifi.password?`P:${wifiEscape(wifi.password)};`:''};`:'';
  const wifiQr=useQr(wifiText);
  if(state&&!online&&!state.server.lan)return <div className="banner warning"><Wifi size={20}/><div><strong>来場者受付用に起動していません</strong><p>いまはこのPCからしか開けない起動方法です。「停止.bat」で止めてから「来場者受付用に起動.bat」で起動すると、来場者用のURLとQRコードがここに表示されます。</p></div></div>;
  return <div className="poster-layout">
    <section className="panel poster-settings"><div className="panel-heading"><h2><span className="heading-mark"/>掲示の設定</h2></div>
      <div className="reconciliation-body">
        <label className="form-label" htmlFor="p-event">掲示するイベント</label>
        <select id="p-event" className="filter-select full" value={eventId??''} onChange={e=>setEventId(e.target.value?Number(e.target.value):null)}><option value="">すべてのイベント（一覧のページ）</option>{events.map(ev=><option key={ev.id} value={ev.id}>{ev.label}{ev.venue?`（${ev.venue}）`:''}</option>)}</select>
        <p className="field-hint">イベントを選ぶと、読み取ったスマホでそのイベントの回の一覧が直接開きます。会場ごとに印刷して貼ってください。</p>
        <label className="form-label" htmlFor="p-url">来場者用のURL</label>
        {online?<>
          <input id="p-url" className="text-input mono" value={url} readOnly/>
          {previewing?<p className="field-hint negative">いまはこのPCでの試用（{location.host}）なので、このQRコードはスマホでは開けません。公開したURLで運営画面を開くと、掲示用のQRコードになります。</p>
          :<p className="field-hint">いま開いているページのURLです。来場者はどのネットワークからでも開けます（Wi-Fiは不要です）。</p>}
        </>:<>
        {urls.length?<select id="p-url" className="filter-select full" value={base} onChange={e=>setBase(e.target.value)}>{urls.map(u=><option key={u} value={u}>{u}</option>)}</select>:<p className="field-hint negative">PCのIPv4アドレスを取得できませんでした。ipconfig で確認したアドレスを使ってください。</p>}
        <p className="field-hint">PCに複数のネットワークがある場合は、来場者がつなぐWi-Fiのアドレス（例: 192.168.…）を選んでください。</p>
        <label className="acknowledgement"><input type="checkbox" checked={wifi.show} onChange={e=>setWifi({...wifi,show:e.target.checked})}/><span>Wi-Fiに接続するためのQRコードも載せる（会場専用のWi-Fiを使う場合）</span></label>
        {wifi.show&&<><label className="form-label" htmlFor="p-ssid">Wi-Fiの名前（SSID）</label><input id="p-ssid" className="text-input" value={wifi.ssid} onChange={e=>setWifi({...wifi,ssid:e.target.value})} maxLength={64}/>
        <label className="form-label" htmlFor="p-pass">パスワード<span className="muted tiny">このPCのブラウザーにだけ保存します</span></label><input id="p-pass" className="text-input" value={wifi.password} onChange={e=>setWifi({...wifi,password:e.target.value})} maxLength={64}/></>}
        </>}
        <button className="button dark full" onClick={()=>window.print()} disabled={!pageQr}><Printer size={17}/>印刷する</button>
        <p className="field-hint">印刷ダイアログで「背景のグラフィック」をオンにすると、色も印刷されます。</p>
      </div>
    </section>
    <section className="poster" aria-label="掲示物のプレビュー">
      <div className="poster-head"><span>{content.eventName}</span><h2>{event?event.label:'イベント整理券'}</h2>{event?.venue&&<p className="poster-venue">会場：{event.venue}</p>}<p>{content.posterTitle}</p></div>
      <div className={`poster-codes ${wifiQr?'two':''}`}>
        {wifiQr&&<div className="poster-code"><span className="poster-step">1</span><img src={wifiQr} alt="Wi-Fi接続用のQRコード"/><strong>Wi-Fiにつなぐ</strong><small>{wifi.ssid}</small></div>}
        <div className="poster-code">{wifiQr&&<span className="poster-step">2</span>}{pageQr?<img src={pageQr} alt="整理券ページのQRコード"/>:<div className="poster-placeholder"/>}<strong>整理券を取る</strong><small className="mono">{url}</small></div>
      </div>
      <p className="poster-note">{content.posterNote}{wifiQr||online?'':'（会場のWi-Fiに接続してから読み取ってください）'}</p>
    </section>
  </div>;
}
