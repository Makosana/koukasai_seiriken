import {useEffect,useRef,useState,type ReactNode} from 'react';
import QRCode from 'qrcode';
import {X} from 'lucide-react';

export function useQr(text:string){
  const [src,setSrc]=useState('');
  useEffect(()=>{
    let live=true;
    if(!text){setSrc('');return;}
    QRCode.toString(text,{type:'svg',margin:1,errorCorrectionLevel:'M',color:{dark:'#252b35',light:'#ffffff'}}).then(svg=>{if(live)setSrc('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg));}).catch(()=>{if(live)setSrc('');});
    return()=>{live=false;};
  },[text]);
  return src;
}

export function Dialog({title,onClose,children,busy=false,wide=false}:{title:string;onClose:()=>void;children:ReactNode;busy?:boolean;wide?:boolean}){
  const ref=useRef<HTMLDivElement>(null),latest=useRef({onClose,busy});
  latest.current={onClose,busy};
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const focusable=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')||[]);
    const timer=setTimeout(()=>focusable()[0]?.focus(),30);
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!latest.current.busy)latest.current.onClose();
      if(e.key==='Tab'){const a=focusable(),first=a[0],last=a[a.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    const prior=document.body.style.overflow;document.body.style.overflow='hidden';document.addEventListener('keydown',key);
    return()=>{clearTimeout(timer);document.body.style.overflow=prior;document.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <div className={wide?'dialog wide':'dialog'} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <button className="icon-button dialog-close" onClick={onClose} disabled={busy} aria-label="閉じる"><X size={20}/></button>
      {children}
    </div>
  </div>;
}

export function Toast({toast,onClose}:{toast:{text:string;error?:boolean}|null;onClose:()=>void}){
  if(!toast)return null;
  return <div className={`toast ${toast.error?'toast-error':''}`} role={toast.error?'alert':'status'}><span>{toast.text}</span><button onClick={onClose} aria-label="通知を閉じる"><X size={15}/></button></div>;
}
