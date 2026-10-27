import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {ApiError} from './api';
import type {AdminState,AdminTicket,AdminWaitEntry,PublicState,Ticket} from './types';
import type {Backend} from './backend';

const URL_=import.meta.env.VITE_SUPABASE_URL as string|undefined;
const KEY=import.meta.env.VITE_SUPABASE_ANON_KEY as string|undefined;
const STATUS:Record<string,number>={login:401,forbidden:403,not_found:404,invalid:400,party:400};

let client:SupabaseClient|null=null;
function db(){
  if(!URL_||!KEY)throw new ApiError('接続先（Supabase）が設定されていません。source/.env.online を確認して、もう一度ビルドしてください。',0,'config');
  return client??=createClient(URL_,KEY,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'seiriken-supabase-auth'}});
}
const networkError=()=>new ApiError('通信を確認できませんでした。電波の良い場所で、もう一度お試しください。',0,'network');

type RpcError={message:string;code?:string;hint?:string|null};
function toApiError(error:RpcError){
  const code=error.hint||'';
  if(code&&code in STATUS||['before','paused','closed','full','remaining','already','started','request_conflict','checked_in','wrong_round','cancelled','finished','invalid_code','overlap','open','already_waiting','waitlist_off','password'].includes(code))
    return new ApiError(error.message,STATUS[code]??409,code);
  if(error.code==='42501'||error.code==='PGRST301'||error.code==='PGRST303')return new ApiError('運営画面を使うにはログインしてください。',401,'login');
  if(!error.code)return networkError();
  return new ApiError('処理を完了できませんでした。時間をおいて、もう一度お試しください。',500,'server');
}

async function rpc<T>(fn:string,args?:Record<string,unknown>,timeout=15000):Promise<T>{
  let result:{data:unknown;error:RpcError|null};
  try{result=await db().rpc(fn,args).abortSignal(AbortSignal.timeout(timeout));}
  catch(e){if(e instanceof ApiError)throw e;throw networkError();}
  if(result.error)throw toApiError(result.error);
  return result.data as T;
}

const jstTime=(iso:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso));
const csvCell=(v:unknown)=>{const s=String(v??'');return /[",\r\n]/.test(s)||/^[=+\-@\t\r]/.test(s)?`"${(/^[=+\-@\t\r]/.test(s)?"'":'')+s.replace(/"/g,'""')}"`:s;};
function stamp(){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
type ExportRow={event_label?:string;via_waitlist?:boolean;label:string;starts_time:string;number:number;party_size:number;preschool?:number;elementary?:number;junior_high?:number;high_school?:number;guardians?:number;status:string;created_at:string;checked_in_at?:string|null;cancelled_at:string|null;cancelled_by:string|null;id:string};

export const supabaseBackend:Backend={
  publicState:()=>rpc<PublicState>('public_state'),
  issue:input=>rpc('issue_ticket',{p_round_id:input.roundId,p_children:input.children,p_guardians:input.guardians,p_device_id:input.deviceId,p_request_id:input.requestId},25000),
  lookup:items=>rpc('lookup_tickets',{p_items:items}),
  findRequest:(requestId,deviceId)=>rpc<{ticket:Ticket|null}>('find_request',{p_request_id:requestId,p_device_id:deviceId}),
  cancel:(id,token)=>rpc('cancel_ticket',{p_id:id,p_token:token}),
  joinWaitlist:input=>rpc('join_waitlist',{p_round_id:input.roundId,p_children:input.children,p_guardians:input.guardians,p_device_id:input.deviceId,p_request_id:input.requestId},25000),
  lookupWaitlist:items=>rpc('lookup_waitlist',{p_items:items.map(x=>({id:x.id,token:x.token}))}),
  leaveWaitlist:(id,token)=>rpc('leave_waitlist',{p_id:id,p_token:token}),
  async adminState(){
    const {data}=await db().auth.getSession();
    if(!data.session)throw new ApiError('運営画面を使うにはログインしてください。',401,'login');
    const s=await rpc<Omit<AdminState,'server'>>('admin_state');
    return {...s,server:{mode:'supabase',lan:false,lanUrls:[location.origin+location.pathname],port:0,isLocal:false,staffCode:null,lastBackup:null,backupError:null,databasePath:null,staffEmail:data.session.user.email??null}};
  },
  async login(input){
    let error:{message:string;status?:number}|null;
    try{({error}=await db().auth.signInWithPassword({email:input.email??'',password:input.password??''}));}
    catch(e){if(e instanceof ApiError)throw e;throw networkError();}
    if(error){
      if(error.status===400)throw new ApiError('メールアドレスかパスワードが違います。',401,'login');
      if(!error.status)throw networkError();
      throw new ApiError('ログインできませんでした。時間をおいて、もう一度お試しください。',error.status,'server');
    }
  },
  async logout(){await db().auth.signOut();},
  async adminOperation(body){await rpc('admin_operation',{p:body});},
  async listTickets(roundId,number){
    return (await rpc<{tickets:AdminTicket[]}>('admin_list_tickets',{p_round_id:roundId,p_number:number?Number(number):null})).tickets;
  },
  async adminCancel(id,password){await rpc('admin_cancel',password?{p_id:id,p_password:password}:{p_id:id});},
  async listWaitlist(roundId){return (await rpc<{entries:AdminWaitEntry[]}>('admin_list_waitlist',{p_round_id:roundId})).entries;},
  checkin:input=>rpc('admin_checkin',{p_round_id:input.roundId,p_code:input.code??null,p_number:input.number??null}),
  async exportCsv(){
    const rows=await rpc<ExportRow[]>('admin_export_tickets',undefined,60000);
    const head=['イベント','回','開演','番号','子ども','未就学児','小学生','中学生','高校生','保護者','状態','受付','キャンセル待ちから','発行時刻','受付時刻','取消時刻','取り消した人','整理券ID'];
    const lines=rows.map(t=>[t.event_label??'',t.label,t.starts_time,t.number,t.party_size,t.preschool??0,t.elementary??0,t.junior_high??0,t.high_school??0,t.guardians??0,t.status==='active'?'有効':'取消',t.checked_in_at?'受付済み':'',t.via_waitlist?'繰り上がり':'',jstTime(t.created_at),t.checked_in_at?jstTime(t.checked_in_at):'',t.cancelled_at?jstTime(t.cancelled_at):'',t.cancelled_by==='visitor'?'本人':t.cancelled_by==='staff'?'スタッフ':'',t.id].map(csvCell).join(','));
    const text='\uFEFF'+[head.join(','),...lines].join('\r\n')+'\r\n';
    return {blob:new Blob([text],{type:'text/csv;charset=utf-8'}),filename:`seiriken-tickets-${stamp()}.csv`};
  },
  async backup(){throw new ApiError('Supabase版では、データはSupabaseに保存されます。CSVで記録を残してください。',400,'invalid');}
};
