export class ApiError extends Error{
  constructor(message:string,public status:number,public code:string){super(message);}
}

const config=(globalThis as typeof globalThis&{SEIRIKEN_CONFIG?:{databaseId?:string;lan?:boolean}}).SEIRIKEN_CONFIG;
const supabaseHost=(()=>{try{return import.meta.env.VITE_SUPABASE_URL?new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0]:'';}catch{return '';}})();
export const scope=config?.databaseId||(supabaseHost?`online-${supabaseHost}`:'local');

export async function api<T>(path:string,body?:unknown,timeout=15000):Promise<T>{
  let res:Response;
  try{
    res=await fetch(path,body===undefined
      ?{cache:'no-store',signal:AbortSignal.timeout(timeout)}
      :{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Seiriken-Request':'1'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  }catch{
    throw new ApiError('通信を確認できませんでした。Wi-Fiの接続を確かめて、もう一度お試しください。',0,'network');
  }
  let data:unknown=null;
  try{data=await res.json();}catch{}
  if(!res.ok){
    const e=data as {error?:string;code?:string}|null;
    throw new ApiError(e?.error||'処理を完了できませんでした。',res.status,e?.code||'server');
  }
  return data as T;
}

export function newId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export const clock=(iso:string)=>new Date(iso).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false});
export const clockSeconds=(ms:number)=>new Date(ms).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export const dateLabel=(ms:number)=>new Date(ms).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short'});
export const fmt=(n:number)=>n.toLocaleString('ja-JP');
