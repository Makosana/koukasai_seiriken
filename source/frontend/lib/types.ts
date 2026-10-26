export type RoundStatus='before'|'open'|'full'|'paused'|'closed'|'finished';

export type PublicRound={
  id:number;label:string;
  starts_time:string;opens_time:string;closes_time:string;
  starts_at:string;opens_at:string;closes_at:string;finishes_at:string;
  capacity_people:number;max_party:number;remaining:number;status:RoundStatus;
};

export type AdminRound=PublicRound&{
  finish_after_minutes:number;paused:boolean;used_people:number;
  active_count:number;cancelled_count:number;cancelled_people:number;last_number:number;
};

export type Ticket={
  id:string;token?:string;round_id:number;round_label:string;starts_time:string;starts_at:string;
  number:number;party_size:number;status:'active'|'cancelled';created_at:string;
  cancelled_at:string|null;cancelled_by:'visitor'|'staff'|null;cancellable:boolean;round_finished:boolean;
};

export type AdminTicket=Ticket&{device:string};

export type PublicState={now:string;eventDate:string;rounds:PublicRound[]};

export type AdminState={
  now:string;eventDate:string;today:string;rounds:AdminRound[];
  totals:{tickets:number;people:number;cancelled:number;capacity:number;remaining:number};
  server:{mode:'local'|'supabase';staffEmail?:string|null;lan:boolean;lanUrls:string[];port:number;isLocal:boolean;staffCode:string|null;lastBackup:string|null;backupError:string|null;databasePath:string|null};
};

export const STATUS_LABELS:Record<RoundStatus,string>={before:'受付前',open:'受付中',full:'満員',paused:'一時停止中',closed:'受付終了',finished:'終了した回'};
