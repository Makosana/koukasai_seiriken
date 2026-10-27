export type RoundStatus='before'|'open'|'full'|'paused'|'closed'|'finished';

export type EventInfo={id:number;label:string;venue:string;notice:string};

export type PublicRound={
  id:number;event_id:number;label:string;
  starts_time:string;opens_time:string;closes_time:string;ends_time:string;duration_minutes:number;
  starts_at:string;opens_at:string;closes_at:string;finishes_at:string;ends_at:string;
  capacity_people:number;max_party:number;remaining:number;status:RoundStatus;
  waiting_count:number;waitlist_open:boolean;
};

export type AdminRound=PublicRound&{
  finish_after_minutes:number;paused:boolean;used_people:number;used_guardians:number;
  active_count:number;cancelled_count:number;cancelled_people:number;last_number:number;
  checked_in_count?:number;checked_in_people?:number;checked_in_guardians?:number;
  waitlist_enabled:boolean;waiting_people:number;promoted_count:number;
};

const minutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
// 開演〜終演（開演＋上演時間）が重なるか。サーバー側と同じ判定
export const overlaps=(a:{starts_time:string;duration_minutes:number},b:{starts_time:string;duration_minutes:number})=>
  minutes(a.starts_time)<minutes(b.starts_time)+b.duration_minutes&&minutes(b.starts_time)<minutes(a.starts_time)+a.duration_minutes;

export type ChildKind='preschool'|'elementary'|'junior_high'|'high_school';
export type Children=Record<ChildKind,number>;
export const CHILD_KINDS:{key:ChildKind;label:string}[]=[{key:'preschool',label:'未就学児'},{key:'elementary',label:'小学生'},{key:'junior_high',label:'中学生'},{key:'high_school',label:'高校生'}];
export const WITH_GUARDIAN:ChildKind[]=['preschool','elementary'];
export const MAX_GUARDIANS=10;
export const emptyChildren=():Children=>({preschool:0,elementary:0,junior_high:0,high_school:0});
export const childTotal=(c:Children)=>CHILD_KINDS.reduce((s,k)=>s+(c[k.key]??0),0);
export const needsGuardian=(c:Children)=>WITH_GUARDIAN.some(k=>(c[k]??0)>0);
export const childSummary=(c:Children|undefined)=>c?CHILD_KINDS.filter(k=>c[k.key]>0).map(k=>`${k.label}${c[k.key]}`).join('・'):'';

export type Ticket={
  id:string;token?:string;round_id:number;round_label:string;starts_time:string;starts_at:string;
  ends_time?:string;event_id?:number;event_label?:string;venue?:string;
  number:number;party_size:number;children?:Children;guardians?:number;status:'active'|'cancelled';created_at:string;
  cancelled_at:string|null;cancelled_by:'visitor'|'staff'|null;cancellable:boolean;round_finished:boolean;
  checked_in_at?:string|null;checkin_code?:string;
};

export const CHECKIN_PREFIX='SRK1:';
export const checkinPayload=(code:string)=>CHECKIN_PREFIX+code;
export function checkinCode(text:string){const m=/^SRK1:([0-9a-f]{32})$/.exec(text.trim());return m?m[1]:null;}

export type AdminTicket=Ticket&{device:string};

export type WaitStatus='waiting'|'promoted'|'cancelled'|'removed'|'expired';
export type WaitEntry={
  id:string;token?:string;round_id:number;round_label:string;event_id:number;event_label:string;venue:string;
  starts_time:string;starts_at:string;ends_time:string;party_size:number;children:Children;guardians:number;
  status:WaitStatus;position:number|null;created_at:string;ended_at:string|null;ticket?:Ticket;
};
export type AdminWaitEntry=WaitEntry&{device:string;ticket_number:number|null};
export const WAIT_LABELS:Record<WaitStatus,string>={waiting:'待っています',promoted:'繰り上がり',cancelled:'本人が取りやめ',removed:'自動で外れた',expired:'開演で終了'};

export type PublicState={now:string;eventDate:string;events:EventInfo[];rounds:PublicRound[]};

export type AdminState={
  now:string;eventDate:string;today:string;events:EventInfo[];rounds:AdminRound[];
  totals:{tickets:number;people:number;guardians:number;cancelled:number;capacity:number;remaining:number;checked_in?:number;checked_in_people?:number;checked_in_guardians?:number;waiting?:number;promoted?:number};
  server:{mode:'local'|'supabase';staffEmail?:string|null;lan:boolean;lanUrls:string[];port:number;isLocal:boolean;staffCode:string|null;lastBackup:string|null;backupError:string|null;databasePath:string|null};
};

export const STATUS_LABELS:Record<RoundStatus,string>={before:'受付前',open:'受付中',full:'満員',paused:'一時停止中',closed:'受付終了',finished:'終了した回'};
