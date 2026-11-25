import type { ReactElement } from 'react';
import type { RosterAgent } from './native-types.ts';

export interface SceneCharacter {
  caption: string;
}

export interface SceneRoom {
  id: string;
  slot: number;
  name: string;
  characters: SceneCharacter[];
  bench: number;
}

export interface Scene {
  cols: number;
  cells: number;
  rooms: SceneRoom[];
}

interface Size {
  width: number;
  height: number;
  edgeRight: boolean;
}

export const ROOM_HEIGHT: number;
export const ROOM_HEIGHT_TALL: number;
export function Room(props: Size & { room: SceneRoom; staggeredCaptions?: boolean }): ReactElement;
export function EmptyRoom(props: Size & { slot: number }): ReactElement;
export function AfkRoom(): ReactElement;
export function Heading(): ReactElement;
export function Roof(): ReactElement;
export function Vent(): ReactElement;
export function Ground(): ReactElement;
export const LINE_BOIL_SEEDS: readonly number[];
export function LineBoilFilter(props: { id: string; seed: number }): ReactElement;
export type BuddyMood = 'awake' | 'sleep' | 'dizzy';
export type CrewMood = BuddyMood | 'search';
export function Buddy(props: { kind: 'claude' | 'codex' | 'unknown'; mood?: BuddyMood }): ReactElement;
export function CrewArt(props: { mood?: CrewMood }): ReactElement;
export interface AgentNode {
  agent: RosterAgent;
  children: AgentNode[];
}
export interface Session {
  id: string;
  root: AgentNode;
  size: number;
  waiting: boolean;
}
export function buildSessions(agents: readonly RosterAgent[]): Session[];
export function groupSessions(agents: readonly RosterAgent[]): {
  focus: Session[];
  recentIdle: Session[];
};
export const HQ_COPY: { recentIdle: string; quiet: string; sessions: string; noName: string };
export function agentDisplayTitle(agent: Pick<RosterAgent, 'id' | 'kind' | 'title'>): string | null;
export function agentMeta(
  agent: Pick<RosterAgent, 'provider' | 'repo' | 'workspace' | 'parentAway' | 'title'>,
): string;
export function recentIdleLabel(count: number): string;
export function stateWords(agent: RosterAgent, nowMs: number): string;
export function summaryLine(agents: readonly RosterAgent[]): string;
export function layoutScene(
  previous: Scene | null,
  sessions: readonly Session[],
  options: { columns: 1 | 2 | 3; nowMs: number },
): Scene;
export function planStage(
  characters: readonly SceneCharacter[],
  bench: number,
  width: number,
): { stations: Array<{ x: number }> };
export function captionsCollide(
  characters: readonly SceneCharacter[],
  stations: readonly { x: number }[],
  size: number,
  measure?: (text: string, size: number) => number,
): boolean;
