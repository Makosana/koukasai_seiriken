import {useEffect,useRef,useState} from 'react';
import {Camera,CameraOff,CircleCheck,TriangleAlert,XCircle,RefreshCw,SwitchCamera,Hash,History} from 'lucide-react';
import type jsQRType from 'jsqr';
import {ApiError,fmt} from './lib/api';
import {backend} from './lib/backend';
import type {AdminRound,AdminTicket} from './lib/types';
import {STATUS_LABELS,checkinCode} from './lib/types';
import {partyText} from './visitor';

type Result={kind:'ok'|'again'|'error';title:string;detail?:string;ticket?:AdminTicket;at:number;id:number};
type Facing='environment'|'user';
const SCAN_EVERY=150,SAME_CODE_MS=4000,AFTER_RESULT_MS=1200;
const time=(iso:string|number)=>new Date(iso).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const ERROR_TITLES:Record<string,string>={
  wrong_round:'別の回の整理券です',cancelled:'取り消された整理券です',not_found:'整理券が見つかりません',before:'まだ受付前です',
  finished:'この回は終了しました',invalid_code:'整理券のQRコードではありません',network:'通信できませんでした',login:'ログインし直してください'
};
function cameraMessage(e:unknown){
  const name=e instanceof DOMException?e.name:'';
  if(name==='NotAllowedError'||name==='SecurityError')return 'カメラの使用が許可されていません。ブラウザーの設定でこのページのカメラを「許可」にしてから、もう一度押してください。';
  if(name==='NotFoundError'||name==='OverconstrainedError')return 'カメラが見つかりません。カメラのある端末（iPad・スマホ）で開いてください。';
  if(name==='NotReadableError')return 'カメラをほかのアプリが使っています。カメラを使っているアプリを閉じてから、もう一度押してください。';
  return 'カメラを起動できませんでした。ページを再読み込みしてから、もう一度押してください。';
}
function pickRound(rounds:AdminRound[]){
  return (rounds.find(r=>r.status==='open'||r.status==='full'||r.status==='paused'||r.status==='closed')??rounds.find(r=>r.status!=='finished')??rounds[0])?.id??null;
}

export default function CheckinTab({rounds,onChecked,onLogin}:{rounds:AdminRound[];onChecked:()=>void;onLogin:()=>void}){
  const [roundId,setRoundId]=useState<number|null>(null);
  const [camera,setCamera]=useState<'off'|'starting'|'on'>('off'),[facing,setFacing]=useState<Facing>('environment');
  const [cameraError,setCameraError]=useState('');
  const [result,setResult]=useState<Result|null>(null),[history,setHistory]=useState<Result[]>([]);
  const [numberDraft,setNumberDraft]=useState(''),[sending,setSending]=useState(false);
  const videoRef=useRef<HTMLVideoElement>(null),canvasRef=useRef<HTMLCanvasElement|null>(null);
  const streamRef=useRef<MediaStream|null>(null),timerRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  const decoderRef=useRef<typeof jsQRType|null>(null),audioRef=useRef<AudioContext|null>(null);
  const roundRef=useRef<number|null>(null),workingRef=useRef(false),pauseUntil=useRef(0),lastRef=useRef({text:'',at:0}),serial=useRef(0);
  const latest=useRef({onChecked,onLogin});latest.current={onChecked,onLogin};

  useEffect(()=>{if(roundId===null||!rounds.some(r=>r.id===roundId))setRoundId(pickRound(rounds));},[rounds,roundId]);
  useEffect(()=>{roundRef.current=roundId;},[roundId]);
  useEffect(()=>()=>{stop();audioRef.current?.close().catch(()=>{});},[]);

  function beep(ok:boolean){
    const ctx=audioRef.current;if(!ctx)return;
    const tones=ok?[[880,0]]:[[330,0],[330,.18]];
    for(const [freq,delay] of tones){
      const o=ctx.createOscillator(),g=ctx.createGain(),t=ctx.currentTime+delay;
      o.frequency.value=freq;o.type='sine';g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.3,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.14);
      o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+.15);
    }
  }
  function show(r:Omit<Result,'at'|'id'>){
    const full={...r,at:Date.now(),id:++serial.current};
    setResult(full);setHistory(h=>[full,...h].slice(0,8));beep(r.kind==='ok');
    pauseUntil.current=Date.now()+AFTER_RESULT_MS;
  }
  async function send(input:{code?:string;number?:number}){
    const round=roundRef.current;
    if(workingRef.current||round===null)return;
    workingRef.current=true;setSending(true);
    try{
      const r=await (await backend()).checkin({roundId:round,...input});
      if(r.replayed)show({kind:'again',title:'受付済みの整理券です',detail:`${r.ticket.checked_in_at?time(r.ticket.checked_in_at):''} に受付しています。もう一度の入場でよいか、確かめてください。`,ticket:r.ticket});
      else{show({kind:'ok',title:'受付完了',ticket:r.ticket});latest.current.onChecked();}
      return true;
    }catch(e){
      const err=e instanceof ApiError?e:new ApiError('処理を完了できませんでした。',0,'network');
      if(err.status===401)latest.current.onLogin();
      show({kind:'error',title:ERROR_TITLES[err.code]??'受付できませんでした',detail:err.message});
      return false;
    }finally{workingRef.current=false;setSending(false);}
  }
  function handleText(text:string){
    const now=Date.now();
    if(lastRef.current.text===text&&now-lastRef.current.at<SAME_CODE_MS){lastRef.current.at=now;return;}
    lastRef.current={text,at:now};
    const code=checkinCode(text);
    if(!code){show({kind:'error',title:ERROR_TITLES.invalid_code,detail:'来場者の「あなたの整理券」の画面に出ているQRコードを読み取ってください。'});return;}
    send({code});
  }
  function scan(){
    const video=videoRef.current,decode=decoderRef.current;
    if(video&&decode&&video.readyState>=2&&!workingRef.current&&Date.now()>=pauseUntil.current&&video.videoWidth){
      const scale=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight));
      const w=Math.round(video.videoWidth*scale),h=Math.round(video.videoHeight*scale);
      const canvas=canvasRef.current??=document.createElement('canvas');
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(ctx){
        ctx.drawImage(video,0,0,w,h);
        const hit=decode(ctx.getImageData(0,0,w,h).data,w,h,{inversionAttempts:'dontInvert'});
        if(hit?.data)handleText(hit.data);
      }
    }
    timerRef.current=setTimeout(scan,SCAN_EVERY);
  }
  function stop(){
    if(timerRef.current)clearTimeout(timerRef.current);timerRef.current=null;
    streamRef.current?.getTracks().forEach(t=>t.stop());streamRef.current=null;
    if(videoRef.current)videoRef.current.srcObject=null;
    setCamera('off');
  }
  async function start(next:Facing=facing){
    setCameraError('');
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setCameraError('この画面ではカメラを使えません。公開URL（https:// で始まるアドレス）で運営画面を開いてください。');return;}
    stop();setCamera('starting');
    try{
      const Ctx=window.AudioContext??(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!audioRef.current&&Ctx)audioRef.current=new Ctx();
      audioRef.current?.resume().catch(()=>{});
      decoderRef.current??=(await import('jsqr')).default;
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:next},width:{ideal:1280},height:{ideal:720}}});
      streamRef.current=stream;
      const video=videoRef.current!;video.srcObject=stream;await video.play();
      setCamera('on');scan();
    }catch(e){stop();setCameraError(cameraMessage(e));}
  }
  function flip(){const next:Facing=facing==='environment'?'user':'environment';setFacing(next);if(camera!=='off')start(next);}
  async function submitNumber(){
    const n=Number(numberDraft);
    if(!/^\d{1,6}$/.test(numberDraft)||n<1)return;
    if(await send({number:n}))setNumberDraft('');
  }

  const selected=rounds.find(r=>r.id===roundId);
  if(!rounds.length)return <section className="panel"><div className="empty"><strong>まだ回がありません</strong><p>「回の管理」から回を登録してください。</p></div></section>;
  return <div className="checkin-layout">
    <section className="panel checkin-camera">
      <div className="panel-heading"><h2><Camera size={18}/>読み取り</h2>
        <select className="filter-select" value={roundId??''} onChange={e=>{setRoundId(Number(e.target.value));setResult(null);}} aria-label="受付する回">{rounds.map(r=><option key={r.id} value={r.id}>{r.label}（開演 {r.starts_time}）{r.status==='finished'?'・終了':''}</option>)}</select>
      </div>
      {selected&&<p className="checkin-round">受付済み <strong>{fmt(selected.checked_in_count??0)}</strong> / 有効 {fmt(selected.active_count)} 枚<span>子ども {fmt(selected.checked_in_people??0)} / {fmt(selected.used_people)} 名</span><span className={`status-chip status-${selected.status}`}><span/>{STATUS_LABELS[selected.status]}</span></p>}
      <div className={`checkin-video ${camera==='on'?'on':''} ${facing==='user'?'mirror':''}`}>
        <video ref={videoRef} playsInline muted autoPlay aria-label="カメラの映像"/>
        {camera==='on'&&<span className="checkin-frame" aria-hidden="true"/>}
        {camera!=='on'&&<div className="checkin-placeholder">{camera==='starting'?<><RefreshCw size={30} className="spin"/>カメラを起動しています</>:<><CameraOff size={34} strokeWidth={1.5}/>カメラは止まっています</>}</div>}
      </div>
      {cameraError&&<p className="field-hint negative checkin-error" role="alert">{cameraError}</p>}
      <div className="checkin-buttons">
        {camera==='off'?<button className="button primary" onClick={()=>start()}><Camera size={17}/>カメラを起動</button>:<button className="button" onClick={stop}><CameraOff size={17}/>カメラを止める</button>}
        <button className="button" onClick={flip} disabled={camera==='starting'}><SwitchCamera size={17}/>{facing==='environment'?'前のカメラに切り替え':'後ろのカメラに切り替え'}</button>
      </div>
      <p className="muted tiny checkin-tip">来場者のQRコードを、枠の中に入れてください。読み取ると自動で受付します。</p>
    </section>

    <div className="checkin-side">
      <section className={`checkin-result ${result?result.kind:'idle'}`} aria-live="assertive">
        {!result&&<><span className="checkin-result-icon"><Camera size={30}/></span><strong>QRコードを読み取ってください</strong><p>結果がここに大きく表示されます。</p></>}
        {result&&<>
          <span className="checkin-result-icon">{result.kind==='ok'?<CircleCheck size={40}/>:result.kind==='again'?<TriangleAlert size={40}/>:<XCircle size={40}/>}</span>
          <strong>{result.title}</strong>
          {result.ticket&&<div className="checkin-ticket"><span className="checkin-no">No.{result.ticket.number}</span><span>{result.ticket.round_label}</span><span>{partyText(result.ticket)}</span></div>}
          {result.detail&&<p>{result.detail}</p>}
          <small>{time(result.at)}</small>
        </>}
      </section>

      <section className="panel">
        <div className="panel-heading"><h2><Hash size={18}/>番号で受付</h2></div>
        <form className="checkin-number" onSubmit={e=>{e.preventDefault();submitNumber();}}>
          <input className="text-input" inputMode="numeric" placeholder="整理券の番号（例: 23）" aria-label="整理券の番号" value={numberDraft} onChange={e=>/^\d{0,6}$/.test(e.target.value)&&setNumberDraft(e.target.value)}/>
          <button className="button primary" disabled={sending||!numberDraft||roundId===null}>{sending?<RefreshCw size={16} className="spin"/>:<CircleCheck size={16}/>}受付する</button>
        </form>
        <p className="muted tiny checkin-tip">QRコードが読み取れないときに使います。上で選んでいる回の番号として受付します。</p>
      </section>

      {history.length>0&&<section className="panel">
        <div className="panel-heading"><h2><History size={18}/>この端末での受付履歴</h2></div>
        <ul className="checkin-history">{history.map(h=><li key={h.id} className={h.kind}><span className="mono">{time(h.at)}</span><strong>{h.ticket?`No.${h.ticket.number}`:'—'}</strong><span>{h.kind==='ok'?'受付完了':h.title}</span></li>)}</ul>
      </section>}
    </div>
  </div>;
}
