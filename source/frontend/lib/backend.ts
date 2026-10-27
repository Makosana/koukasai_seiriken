import {api,ApiError} from './api';
import type {AdminState,AdminTicket,Children,PublicState,Ticket} from './types';

export type Saved={id:string;token:string;ticket?:Ticket};
export type IssueInput={roundId:number;children:Children;guardians:number;deviceId:string;requestId:string};
export type LoginInput={code?:string;email?:string;password?:string};
export type CheckinInput={roundId:number;code?:string;number?:number};

export type Backend={
  publicState():Promise<PublicState>;
  issue(input:IssueInput):Promise<{ticket:Ticket;replayed:boolean}>;
  lookup(items:Saved[]):Promise<{now:string;tickets:(Ticket|null)[]}>;
  findRequest(requestId:string,deviceId:string):Promise<{ticket:Ticket|null}>;
  cancel(id:string,token:string):Promise<{ticket:Ticket;replayed:boolean}>;
  adminState():Promise<AdminState>;
  login(input:LoginInput):Promise<void>;
  logout():Promise<void>;
  adminOperation(body:Record<string,unknown>):Promise<void>;
  listTickets(roundId:number,number?:string):Promise<AdminTicket[]>;
  adminCancel(id:string):Promise<void>;
  checkin(input:CheckinInput):Promise<{ticket:AdminTicket;replayed:boolean}>;
  exportCsv():Promise<{blob:Blob;filename:string}>;
  backup():Promise<string>;
};

export const MODE:'local'|'supabase'=import.meta.env.MODE==='online'?'supabase':'local';

const localBackend:Backend={
  publicState:()=>api<PublicState>('/api/public/state'),
  issue:input=>api('/api/public/issue',input,25000),
  lookup:items=>api('/api/public/tickets',{items}),
  findRequest:(requestId,deviceId)=>api('/api/public/request',{requestId,deviceId}),
  cancel:(id,token)=>api('/api/public/cancel',{id,token}),
  async adminState(){const s=await api<AdminState>('/api/admin/state');return {...s,server:{...s.server,mode:'local'}};},
  async login(input){await api('/api/admin/login',{code:input.code??''});},
  async logout(){},
  async adminOperation(body){await api('/api/admin/operation',body);},
  async listTickets(roundId,number){
    const q=new URLSearchParams({round:String(roundId)});if(number)q.set('number',number);
    return (await api<{tickets:AdminTicket[]}>(`/api/admin/tickets?${q}`)).tickets;
  },
  async adminCancel(id){await api('/api/admin/cancel',{id});},
  async checkin(){throw new ApiError('入場受付はオンライン版（Supabase）だけで使えます。',400,'invalid');},
  async exportCsv(){
    let r:Response;
    try{r=await fetch('/api/admin/csv',{cache:'no-store'});}
    catch{throw new ApiError('通信を確認できませんでした。',0,'network');}
    if(!r.ok){const b=await r.json().catch(()=>({})) as {error?:string;code?:string};throw new ApiError(b.error||'出力できませんでした。',r.status,b.code||'server');}
    return {blob:await r.blob(),filename:r.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||'seiriken-tickets.csv'};
  },
  async backup(){return (await api<{filename:string}>('/api/admin/backup',{})).filename;}
};

let loaded:Promise<Backend>|null=null;
export function backend():Promise<Backend>{
  return loaded??=import.meta.env.MODE==='online'?import('./backend-supabase').then(m=>m.supabaseBackend):Promise.resolve(localBackend);
}
