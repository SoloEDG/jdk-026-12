export type Mark = "unknown" | "filled" | "cross";
export type Tool = "filled" | "cross" | "unknown";
export interface Puzzle {
  id: string;
  title: string;
  collection: string;
  level: "入门" | "进阶" | "挑战";
  size: number;
  solution: number[];
  color: string;
}
export interface Move {
  index: number;
  before: Mark;
  after: Mark;
}
export interface Session {
  puzzleId: string;
  marks: Mark[];
  moves: Move[];
  hints: number;
  checks: number;
  seconds: number;
  solved: boolean;
  updatedAt: number;
}
export interface SolveRecord {
  id: string;
  puzzleId: string;
  seconds: number;
  hints: number;
  checks: number;
  finishedAt: number;
}
export interface GameDocument {
  version: 1;
  activeId: string;
  sessions: Record<string, Session>;
  records: SolveRecord[];
  routes: Record<string, RouteProgress>;
}
export type GameAction =
  | { type: "open"; id: string }
  | { type: "mark"; index: number; mark: Mark }
  | { type: "undo" }
  | { type: "hint"; index: number; mark: Mark }
  | { type: "check" }
  | { type: "tick" }
  | { type: "reset" }
  | { type: "commitRoutes"; routeId: string; progress: RouteProgress }
  | { type: "syncRoutes"; routes: Record<string, RouteProgress> };
export type NodeRequirement =
  | { type: "nodes"; nodeIds: string[] }
  | { type: "anyNode"; nodeIds: string[] }
  | { type: "unassisted"; count: number };
export interface StoryNode {
  id: string;
  zone: string;
  title: string;
  hint: string;
  puzzleId: string;
  requires: NodeRequirement[];
  branchGroup?: string;
  petals: number;
  badge: string;
  finale?: boolean;
}
export interface StoryRoute {
  id: string;
  version: number;
  title: string;
  synopsis: string;
  accent: string;
  nodes: StoryNode[];
}
export interface NodeClaim {
  recordId: string;
  petals: number;
  badge: string;
  claimedAt: number;
}
export interface NodeDraft {
  recordId: string | null;
  reason: string;
  createdAt: number;
}
export interface RouteProgress {
  routeId: string;
  routeVersion: number;
  revision: number;
  claims: Record<string, NodeClaim>;
  drafts: Record<string, NodeDraft>;
  attributed: string[];
  legacyPetals: number;
  legacyNotes: string[];
}
export type NodeState =
  | "claimed"
  | "available"
  | "locked"
  | "forfeited"
  | "isolated";
export type RouteAction =
  | { type: "claim"; routeId: string; nodeId: string }
  | { type: "switchBranch"; routeId: string; nodeId: string }
  | { type: "retryDraft"; routeId: string; nodeId: string }
  | { type: "discardDraft"; routeId: string; nodeId: string };
