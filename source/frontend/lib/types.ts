export type RoundStatus='before'|'open'|'full'|'paused'|'closed'|'finished';

export type PublicRound={
  id:number;label:string;
  starts_time:string;opens_time:string;closes_time:string;
  starts_at:string;opens_at:string;closes_at:string;finishes_at:string;
  capacity_people:number;max_party:number;remaining:number;status:RoundStatus;
};

export type AdminRound=PublicRound&{
  finish_after_minutes:number;paused:boolean;used_people:number;used_guardians:number;
  active_count:number;cancelled_count:number;cancelled_people:number;last_number:number;
};

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
  number:number;party_size:number;children?:Children;guardians?:number;status:'active'|'cancelled';created_at:string;
  cancelled_at:string|null;cancelled_by:'visitor'|'staff'|null;cancellable:boolean;round_finished:boolean;
};

export type AdminTicket=Ticket&{device:string};

export type PublicState={now:string;eventDate:string;rounds:PublicRound[]};

export type AdminState={
  now:string;eventDate:string;today:string;rounds:AdminRound[];
  totals:{tickets:number;people:number;guardians:number;cancelled:number;capacity:number;remaining:number};
  server:{mode:'local'|'supabase';staffEmail?:string|null;lan:boolean;lanUrls:string[];port:number;isLocal:boolean;staffCode:string|null;lastBackup:string|null;backupError:string|null;databasePath:string|null};
};

export const STATUS_LABELS:Record<RoundStatus,string>={before:'受付前',open:'受付中',full:'満員',paused:'一時停止中',closed:'受付終了',finished:'終了した回'};
