import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import QRCode from 'qrcode';
import {Ticket as TicketIcon,CalendarClock,ListOrdered,ChartNoAxesCombined,QrCode,Plus,Pencil,Trash2,Pause,Play,RefreshCw,Search,TriangleAlert,ChevronRight,Download,Printer,KeyRound,PanelLeftClose,PanelLeftOpen,ShieldCheck,Wifi,DatabaseBackup,LockKeyhole,Users,XCircle,ExternalLink,LogOut,Cloud} from 'lucide-react';
import {ApiError,fmt} from './lib/api';
import {backend,MODE} from './lib/backend';
import type {AdminRound,AdminState,AdminTicket} from './lib/types';
import {STATUS_LABELS} from './lib/types';
import {content} from './content';
import {Dialog,Toast} from './ui';
import {tone} from './visitor';

type Tab='rounds'|'tickets'|'summary'|'poster';
type RoundForm={id?:number;label:string;startsTime:string;opensTime:string;closesTime:string;capacity:string;maxParty:string;finishAfterMinutes:string};
const tabs=[{id:'rounds' as Tab,label:'回の管理',icon:CalendarClock},{id:'tickets' as Tab,label:'整理券の一覧',icon:ListOrdered},{id:'summary' as Tab,label:'集計・出力',icon:ChartNoAxesCombined},{id:'poster' as Tab,label:'掲示用QR',icon:QrCode}];
const titles:Record<Tab,{title:string;subtitle:string;kicker:string}>={
  rounds:{title:'回の管理',subtitle:'回ごとの定員と受付時間を登録します。受付は時間になると自動で始まり、満員か終了時刻で締め切ります。',kicker:'ROUNDS'},
  tickets:{title:'整理券の一覧',subtitle:'入場口で番号を照合したり、疑わしい整理券を取り消したりできます。',kicker:'TICKETS'},
  summary:{title:'集計・出力',subtitle:'配布した枚数と人数を確認し、CSVで記録を残します。',kicker:'SUMMARY'},
  poster:{title:'掲示用QR',subtitle:'会場に貼るQRコードを表示・印刷します。',kicker:'POSTER'}
};
const WIFI_KEY='seiriken-admin-wifi-v1';
const time=(iso:string)=>new Date(iso).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const isTime=(v:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isCount=(v:string,min:number,max:number)=>/^\d+$/.test(v)&&Number(v)>=min&&Number(v)<=max;
function emptyForm(last?:AdminRound):RoundForm{
  if(!last)return {label:'',startsTime:'10:00',opensTime:'09:00',closesTime:'10:00',capacity:'100',maxParty:'4',finishAfterMinutes:'30'};
  return {label:'',startsTime:last.starts_time,opensTime:last.opens_time,closesTime:last.closes_time,capacity:String(last.capacity_people),maxParty:String(last.max_party),finishAfterMinutes:String(last.finish_after_minutes)};
}
function wifiEscape(s:string){return s.replace(/([\\;,:"])/g,'\\$1');}

export default function Admin(){
  const [state,setState]=useState<AdminState|null>(null);
  const [auth,setAuth]=useState<'checking'|'ok'|'login'>('checking');
  const [connection,setConnection]=useState<'loading'|'ok'|'error'>('loading');
  const [tab,setTab]=useState<Tab>('rounds'),[navOpen,setNavOpen]=useState(false);
  const [busy,setBusy]=useState(false),[toast,setToast]=useState<{text:string;error?:boolean}|null>(null);
  const [code,setCode]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[loginError,setLoginError]=useState('');
  const [form,setForm]=useState<RoundForm|null>(null),[formError,setFormError]=useState('');
  const [deleteTarget,setDeleteTarget]=useState<AdminRound|null>(null);
  const [dateDraft,setDateDraft]=useState('');
  const [ticketRound,setTicketRound]=useState<number|null>(null),[numberDraft,setNumberDraft]=useState(''),[numberQuery,setNumberQuery]=useState('');
  const [list,setList]=useState<AdminTicket[]>([]),[listBusy,setListBusy]=useState(false),[cancelTarget,setCancelTarget]=useState<AdminTicket|null>(null);
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
    try{const tickets=await (await backend()).listTickets(ticketRound,numberQuery);if(serial===listSerial.current)setList(tickets);}
    catch(e){if(serial===listSerial.current){setList([]);notify(e instanceof Error?e.message:'一覧を読み込めません。',true);}}
    finally{if(serial===listSerial.current)setListBusy(false);}
  },[ticketRound,numberQuery,notify]);
  const lastNumber=state?.rounds.find(r=>r.id===ticketRound)?.last_number;
  const cancelledCount=state?.rounds.find(r=>r.id===ticketRound)?.cancelled_count;
  useEffect(()=>{if(tab==='tickets')loadTickets();},[tab,loadTickets,lastNumber,cancelledCount]);

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
    if(!isCount(form.capacity,1,10000)||!isCount(form.maxParty,1,20)||!isCount(form.finishAfterMinutes,0,600)){setFormError('定員は1〜10000、1枚あたりの人数は1〜20、終了扱いまでの時間は0〜600分で入力してください。');return;}
    setFormError('');
    const ok=await operate({action:form.id?'update':'create',id:form.id,label,startsTime:form.startsTime,opensTime:form.opensTime,closesTime:form.closesTime,capacity:Number(form.capacity),maxParty:Number(form.maxParty),finishAfterMinutes:Number(form.finishAfterMinutes)},form.id?'回を更新しました。':'回を追加しました。');
    if(ok)setForm(null);
  }
  async function staffCancel(t:AdminTicket){
    setBusy(true);
    try{await (await backend()).adminCancel(t.id);notify(`No.${t.number} を取り消しました。`);setCancelTarget(null);await refresh();await loadTickets();}
    catch(e){notify(e instanceof Error?e.message:'取り消せませんでした。',true);}
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
  function chooseTab(id:Tab){setTab(id);setNavOpen(false);}

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
  const selected=rounds.find(r=>r.id===ticketRound);
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
            <Stat label="発行済み（有効）" value={state?.totals.tickets??0} unit="枚" icon={<TicketIcon size={18}/>} color="peach" foot={`${fmt(state?.totals.people??0)} 名分`}/>
            <Stat label="残り人数" value={state?.totals.remaining??0} unit="名" icon={<Users size={18}/>} color="blue" foot={`定員合計 ${fmt(state?.totals.capacity??0)} 名`}/>
            <Stat label="取消" value={state?.totals.cancelled??0} unit="枚" icon={<XCircle size={18}/>} color="purple" foot="本人とスタッフの合計"/>
          </section>
          <section className="panel date-panel"><div className="panel-heading"><h2><span className="heading-mark"/>開催日</h2><span className="muted tiny">回の時刻はこの日付で判定します</span></div>
            <div className="date-row"><input type="date" className="text-input" value={dateDraft} onChange={e=>setDateDraft(e.target.value)} aria-label="開催日"/><button className="button" disabled={busy||!dateDraft||dateDraft===state?.eventDate} onClick={()=>operate({action:'settings',eventDate:dateDraft},'開催日を保存しました。')}>保存</button>{state&&state.eventDate!==state.today&&<button className="button small" disabled={busy} onClick={()=>{setDateDraft(state.today);operate({action:'settings',eventDate:state.today},'開催日を今日にしました。');}}>今日にする</button>}</div>
          </section>
          <section className="panel"><div className="panel-heading"><h2><CalendarClock size={18}/>回の一覧</h2><button className="button primary small" disabled={busy||connection!=='ok'} onClick={()=>{setFormError('');setForm(emptyForm(rounds[rounds.length-1]));}}><Plus size={16}/>回を追加</button></div>
            {rounds.length?<div className="table-scroll"><table><thead><tr><th>回</th><th>開演</th><th>受付時間</th><th>状態</th><th className="right">発行</th><th className="right">残り / 定員</th><th className="right">操作</th></tr></thead><tbody>{rounds.map(r=><tr key={r.id} className={r.status==='finished'?'voided':''}>
              <td><span className={`round-dot ${tone(r.id)}`}/>{r.label}<span className="table-note">1枚 最大{r.max_party}名・開演{r.finish_after_minutes}分後に終了扱い</span></td>
              <td className="mono">{r.starts_time}</td>
              <td className="mono">{r.opens_time}〜{r.closes_time}</td>
              <td><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span>{r.paused&&r.status!=='paused'&&<span className="table-note">一時停止の設定あり</span>}</td>
              <td className="right mono">{fmt(r.active_count)} 枚<span className="table-note">{fmt(r.used_people)} 名</span></td>
              <td className="right mono">{fmt(r.remaining)} / {fmt(r.capacity_people)}<div className="meter"><span style={{width:`${Math.min(100,r.used_people/r.capacity_people*100)}%`}}/></div></td>
              <td className="right"><div className="row-actions">
                {r.paused?<button className="button small" disabled={busy} onClick={()=>operate({action:'resume',id:r.id},`${r.label}の受付を再開しました。`)}><Play size={14}/>再開</button>
                :<button className="button small" disabled={busy||r.status==='finished'} onClick={()=>operate({action:'pause',id:r.id},`${r.label}の受付を一時停止しました。`)}><Pause size={14}/>一時停止</button>}
                <button className="icon-button" disabled={busy} aria-label={`${r.label}を編集`} onClick={()=>{setFormError('');setForm({id:r.id,label:r.label,startsTime:r.starts_time,opensTime:r.opens_time,closesTime:r.closes_time,capacity:String(r.capacity_people),maxParty:String(r.max_party),finishAfterMinutes:String(r.finish_after_minutes)});}}><Pencil size={16}/></button>
                <button className="icon-button" disabled={busy||r.active_count+r.cancelled_count>0} title={r.active_count+r.cancelled_count>0?'整理券を発行した回は削除できません':''} aria-label={`${r.label}を削除`} onClick={()=>setDeleteTarget(r)}><Trash2 size={16}/></button>
              </div></td>
            </tr>)}</tbody></table></div>:<div className="empty"><div className="empty-icon"><CalendarClock size={26}/></div><strong>まだ回がありません</strong><p>「回を追加」から、公演の回を登録してください。</p></div>}
            <div className="table-bottom"><ShieldCheck size={14}/>状態は現在時刻・残り人数・一時停止から自動で決まります。<span>5秒ごとに更新</span></div>
          </section>
        </>}

        {tab==='tickets'&&<section className="panel"><div className="panel-heading"><div><h2><ListOrdered size={18}/>整理券</h2>{selected&&<p className="muted tiny">有効 {fmt(selected.active_count)} 枚・{fmt(selected.used_people)} 名／取消 {fmt(selected.cancelled_count)} 枚／最後の番号 No.{selected.last_number}</p>}</div><button className="icon-button" onClick={()=>loadTickets()} aria-label="一覧を更新"><RefreshCw size={18} className={listBusy?'spin':''}/></button></div>
          <div className="history-tools">
            <select className="filter-select" value={ticketRound??''} onChange={e=>{setTicketRound(Number(e.target.value));setNumberDraft('');setNumberQuery('');}} aria-label="回を選ぶ">{rounds.map(r=><option key={r.id} value={r.id}>{r.label}（開演 {r.starts_time}）</option>)}</select>
            <form className="search-field" onSubmit={e=>{e.preventDefault();setNumberQuery(numberDraft.trim());}}><Search size={18}/><input inputMode="numeric" placeholder="番号で照合（例: 23）" aria-label="番号で検索" value={numberDraft} onChange={e=>/^\d{0,6}$/.test(e.target.value)&&setNumberDraft(e.target.value)}/>{numberQuery&&<button type="button" onClick={()=>{setNumberDraft('');setNumberQuery('');}}>解除</button>}<button type="submit">照合</button></form>
          </div>
          {rounds.length?<div className="table-scroll"><table><thead><tr><th>番号</th><th>人数</th><th>状態</th><th>発行時刻</th><th>端末</th><th className="right">操作</th></tr></thead><tbody>{list.map(t=><tr key={t.id} className={t.status==='cancelled'?'voided':''}>
            <td><strong className="ticket-no">No.{t.number}</strong></td>
            <td className="mono">{t.party_size} 名</td>
            <td><span className={`kind-pill ${t.status==='active'?'sale':'void'}`}>{t.status==='active'?'有効':t.cancelled_by==='staff'?'取消（スタッフ）':'取消（本人）'}</span>{t.cancelled_at&&<span className="table-note">{time(t.cancelled_at)}</span>}</td>
            <td className="mono">{time(t.created_at)}</td>
            <td className="mono muted">{t.device}</td>
            <td className="right">{t.status==='active'&&<button className="button small void-button" disabled={busy} onClick={()=>setCancelTarget(t)}>取り消す</button>}</td>
          </tr>)}</tbody></table>
          {listBusy&&!list.length&&<div className="table-loading"><RefreshCw size={16} className="spin"/>読み込み中</div>}
          {!listBusy&&!list.length&&<div className="empty"><div className="empty-icon"><TicketIcon size={26}/></div><strong>{numberQuery?`No.${numberQuery} の整理券はありません`:'まだ整理券がありません'}</strong><p>{numberQuery?'番号と回を確かめてください。存在しない番号の場合は、偽造の可能性があります。':'来場者が整理券を取ると、ここに表示されます。'}</p></div>}
          </div>:<div className="empty"><strong>まだ回がありません</strong><p>「回の管理」から回を登録してください。</p></div>}
          <div className="table-bottom"><ShieldCheck size={14}/>端末欄は同じスマホかどうかを見分けるための記号です。<span>{list.length}件を表示</span></div>
        </section>}

        {tab==='summary'&&<>
          <section className="stats-grid">
            <Stat label="発行済み（有効）" value={state?.totals.tickets??0} unit="枚" icon={<TicketIcon size={18}/>} color="peach" foot="取消分を除く"/>
            <Stat label="入場予定の人数" value={state?.totals.people??0} unit="名" icon={<Users size={18}/>} color="green" foot="有効な整理券の合計"/>
            <Stat label="残り人数" value={state?.totals.remaining??0} unit="名" icon={<ListOrdered size={18}/>} color="blue" foot={`定員合計 ${fmt(state?.totals.capacity??0)} 名`}/>
            <Stat label="取消" value={state?.totals.cancelled??0} unit="枚" icon={<XCircle size={18}/>} color="purple" foot="本人とスタッフの合計"/>
          </section>
          <section className="panel"><div className="panel-heading"><h2><span className="heading-mark"/>回ごとの集計</h2><button className="button small" disabled={busy} onClick={downloadCsv}><Download size={16}/>CSVを出力</button></div>
            <div className="table-scroll"><table><thead><tr><th>回</th><th>開演</th><th>状態</th><th className="right">有効</th><th className="right">人数</th><th className="right">取消</th><th className="right">残り</th><th className="right">定員</th></tr></thead><tbody>{rounds.map(r=><tr key={r.id}><td><span className={`round-dot ${tone(r.id)}`}/>{r.label}</td><td className="mono">{r.starts_time}</td><td><span className={`status-chip status-${r.status}`}><span/>{STATUS_LABELS[r.status]}</span></td><td className="right mono">{fmt(r.active_count)} 枚</td><td className="right mono">{fmt(r.used_people)} 名</td><td className="right mono">{fmt(r.cancelled_count)} 枚</td><td className="right mono">{fmt(r.remaining)} 名</td><td className="right mono">{fmt(r.capacity_people)} 名</td></tr>)}</tbody></table>{!rounds.length&&<div className="empty"><strong>まだ回がありません</strong></div>}</div>
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
      <label className="form-label" htmlFor="f-label">回の名前<span className="muted tiny">空欄なら「{form.startsTime}の回」</span></label>
      <input id="f-label" className="text-input" maxLength={40} value={form.label} placeholder={`${form.startsTime}の回`} onChange={e=>setForm({...form,label:e.target.value})}/>
      <div className="form-three">
        <div><label className="form-label" htmlFor="f-starts">開演</label><input id="f-starts" type="time" className="text-input" value={form.startsTime} onChange={e=>setForm({...form,startsTime:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-opens">受付開始</label><input id="f-opens" type="time" className="text-input" value={form.opensTime} onChange={e=>setForm({...form,opensTime:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-closes">受付終了</label><input id="f-closes" type="time" className="text-input" value={form.closesTime} onChange={e=>setForm({...form,closesTime:e.target.value})}/></div>
      </div>
      <div className="form-three">
        <div><label className="form-label" htmlFor="f-cap">定員（人数）</label><input id="f-cap" inputMode="numeric" className="text-input" value={form.capacity} onChange={e=>/^\d{0,5}$/.test(e.target.value)&&setForm({...form,capacity:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-max">1枚の最大人数</label><input id="f-max" inputMode="numeric" className="text-input" value={form.maxParty} onChange={e=>/^\d{0,2}$/.test(e.target.value)&&setForm({...form,maxParty:e.target.value})}/></div>
        <div><label className="form-label" htmlFor="f-fin">終了扱い（開演後 分）</label><input id="f-fin" inputMode="numeric" className="text-input" value={form.finishAfterMinutes} onChange={e=>/^\d{0,3}$/.test(e.target.value)&&setForm({...form,finishAfterMinutes:e.target.value})}/></div>
      </div>
      {form.id&&(()=>{const r=rounds.find(x=>x.id===form.id);return r&&r.used_people>0?<p className="field-hint">すでに {r.used_people} 名分を発行しています。定員はそれ以上にしてください。</p>:null;})()}
      {formError&&<p className="field-hint negative" role="alert">{formError}</p>}
      <div className="dialog-buttons spaced"><button className="button" disabled={busy} onClick={()=>setForm(null)}>やめる</button><button className="button primary" disabled={busy} onClick={saveForm}>{busy&&<RefreshCw size={16} className="spin"/>}{form.id?'更新する':'追加する'}</button></div>
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
      <div className="confirm-values"><div><span>回</span><strong>{cancelTarget.round_label}</strong></div><div><span>人数</span><strong>{cancelTarget.party_size} 名</strong></div><div><span>発行時刻</span><strong>{time(cancelTarget.created_at)}</strong></div></div>
      <p className="dialog-description">取り消すと、来場者のスマホにも「スタッフにより取り消された整理券」と表示されます。元に戻せません。</p>
      <div className="dialog-buttons"><button className="button" disabled={busy} onClick={()=>setCancelTarget(null)}>やめる</button><button className="button destructive" disabled={busy} onClick={()=>staffCancel(cancelTarget)}>{busy&&<RefreshCw size={16} className="spin"/>}取り消す</button></div>
    </Dialog>}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;
}

function Stat({label,value,unit,icon,color,foot}:{label:string;value:number;unit:string;icon:ReactNode;color:string;foot:string}){
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><div className="stat-number">{fmt(value)}<small>{unit}</small></div><div className="stat-foot">{foot}</div></div>;
}

function useQr(text:string){
  const [src,setSrc]=useState('');
  useEffect(()=>{
    let live=true;
    if(!text){setSrc('');return;}
    QRCode.toString(text,{type:'svg',margin:1,errorCorrectionLevel:'M',color:{dark:'#252b35',light:'#ffffff'}}).then(svg=>{if(live)setSrc('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg));}).catch(()=>{if(live)setSrc('');});
    return()=>{live=false;};
  },[text]);
  return src;
}

function PosterTab({state}:{state:AdminState|null}){
  const urls=state?.server.lanUrls??[];
  const [url,setUrl]=useState('');
  const [wifi,setWifi]=useState<{ssid:string;password:string;show:boolean}>(()=>{try{return {ssid:'',password:'',show:false,...JSON.parse(localStorage.getItem(WIFI_KEY)||'{}')};}catch{return {ssid:'',password:'',show:false};}});
  useEffect(()=>{if(urls.length&&!urls.includes(url))setUrl(urls[0]);},[urls.join(','),url]);
  useEffect(()=>{try{localStorage.setItem(WIFI_KEY,JSON.stringify(wifi));}catch{}},[wifi]);
  const pageQr=useQr(url);
  const online=state?.server.mode==='supabase';
  const previewing=online&&/^(localhost|127\.|\[::1\])/.test(location.hostname);
  const wifiText=!online&&wifi.show&&wifi.ssid?`WIFI:T:${wifi.password?'WPA':'nopass'};S:${wifiEscape(wifi.ssid)};${wifi.password?`P:${wifiEscape(wifi.password)};`:''};`:'';
  const wifiQr=useQr(wifiText);
  if(state&&!online&&!state.server.lan)return <div className="banner warning"><Wifi size={20}/><div><strong>来場者受付用に起動していません</strong><p>いまはこのPCからしか開けない起動方法です。「停止.bat」で止めてから「来場者受付用に起動.bat」で起動すると、来場者用のURLとQRコードがここに表示されます。</p></div></div>;
  return <div className="poster-layout">
    <section className="panel poster-settings"><div className="panel-heading"><h2><span className="heading-mark"/>掲示の設定</h2></div>
      <div className="reconciliation-body">
        <label className="form-label" htmlFor="p-url">来場者用のURL</label>
        {online?<>
          <input id="p-url" className="text-input mono" value={url} readOnly/>
          {previewing?<p className="field-hint negative">いまはこのPCでの試用（{location.host}）なので、このQRコードはスマホでは開けません。公開したURLで運営画面を開くと、掲示用のQRコードになります。</p>
          :<p className="field-hint">いま開いているページのURLです。来場者はどのネットワークからでも開けます（Wi-Fiは不要です）。</p>}
        </>:<>
        {urls.length?<select id="p-url" className="filter-select full" value={url} onChange={e=>setUrl(e.target.value)}>{urls.map(u=><option key={u} value={u}>{u}</option>)}</select>:<p className="field-hint negative">PCのIPv4アドレスを取得できませんでした。ipconfig で確認したアドレスを使ってください。</p>}
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
      <div className="poster-head"><span>{content.eventName}</span><h2>{content.performanceName}</h2><p>{content.posterTitle}</p></div>
      <div className={`poster-codes ${wifiQr?'two':''}`}>
        {wifiQr&&<div className="poster-code"><span className="poster-step">1</span><img src={wifiQr} alt="Wi-Fi接続用のQRコード"/><strong>Wi-Fiにつなぐ</strong><small>{wifi.ssid}</small></div>}
        <div className="poster-code">{wifiQr&&<span className="poster-step">2</span>}{pageQr?<img src={pageQr} alt="整理券ページのQRコード"/>:<div className="poster-placeholder"/>}<strong>整理券を取る</strong><small className="mono">{url}</small></div>
      </div>
      <p className="poster-note">{content.posterNote}{wifiQr||online?'':'（会場のWi-Fiに接続してから読み取ってください）'}</p>
    </section>
  </div>;
}
