// #395 — client-side mirror of the server work-time payload
// (apps/server/src/core/page/work-time). Shapes returned by POST /pages/history/time.

export type WorkSessionClass = "work" | "agent_only";

export interface IDayWindow {
  start: number;
  end: number;
  class: WorkSessionClass;
}

export interface IPerDay {
  day: number;
  dayISO: string;
  activeMs: number;
  agentMs: number;
  windows: IDayWindow[];
}

export interface IWorkTimeConfig {
  tGap: number;
  agentTGap: number;
  pIn: number;
  pOut: number;
  pSingle: number;
  excludeGit: boolean;
  burstCapMs?: number;
  dedupRoundMs: number;
}

export interface IPageWorkTime {
  workMs: number;
  agentOnlyMs: number;
  perDay: IPerDay[];
  config: IWorkTimeConfig;
  tz: string;
}
