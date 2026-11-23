import type {
  GameDocument,
  Mark,
  NodeClaim,
  NodeDraft,
  Puzzle,
  RouteProgress,
} from "../../../shared/types";
import { newDocument, newSession, isSolved } from "../../../shared/document";
import { storyRoutes } from "../../story/model/routes";
import { normalizeRoutes } from "../../story/model/progress";
export const STORAGE_KEY = "gejian.document.v1";
export function loadDocument(puzzles: Puzzle[]): {
  document: GameDocument;
  warning: string;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { document: newDocument(puzzles[0]), warning: "" };
    const data = JSON.parse(raw) as GameDocument;
    if (data.version !== 1 || !data.sessions || !Array.isArray(data.records))
      throw Error("unsupported");
    const sessions: GameDocument["sessions"] = {};
    for (const puzzle of puzzles) {
      const saved = data.sessions[puzzle.id];
      if (
        saved &&
        Array.isArray(saved.marks) &&
        saved.marks.length === puzzle.size ** 2 &&
        saved.marks.every((m: Mark) =>
          ["filled", "unknown", "cross"].includes(m),
        )
      ) {
        const session = {
          ...newSession(puzzle),
          marks: saved.marks,
          hints: Math.min(3, Math.max(0, Number(saved.hints) || 0)),
          checks: Math.max(0, Number(saved.checks) || 0),
          seconds: Math.max(0, Number(saved.seconds) || 0),
          updatedAt: Date.now(),
        };
        sessions[puzzle.id] = { ...session, solved: isSolved(puzzle, session) };
      }
    }
    const active = puzzles.find((p) => p.id === data.activeId) ?? puzzles[0];
    sessions[active.id] ??= newSession(active);
    const records = data.records.filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        puzzles.some((p) => p.id === r.puzzleId) &&
        Number.isFinite(r.seconds) &&
        Number.isFinite(r.finishedAt) &&
        Number.isFinite(r.hints) &&
        Number.isFinite(r.checks),
    );
    // 路线进度按各自版本恢复：循环、缺失题目或版本迁移只隔离节点，不清空成绩。
    const routes = normalizeRoutes(
      storyRoutes,
      puzzles,
      data.routes && typeof data.routes === "object" ? data.routes : {},
      records,
    );
    return {
      document: { version: 1, activeId: active.id, sessions, records, routes },
      warning: "",
    };
  } catch {
    return {
      document: newDocument(puzzles[0]),
      warning:
        "存档无法读取，已打开新的解题页。原存档未覆盖，请手动保存新进度。",
    };
  }
}
// 保存时按 revision 合并路线进度：另一个窗口已提交的更新不会被旧快照覆盖。
// 完成记录不可变，按 id 合并，避免两个窗口互相覆盖导致路线领取悬空。
export function saveDocument(document: GameDocument): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let routes = document.routes;
    let records = document.records;
    if (raw) {
      const stored = JSON.parse(raw) as GameDocument;
      if (Array.isArray(stored?.records)) {
        const seen = new Set(records.map((r) => r.id));
        records = [
          ...records,
          ...stored.records.filter((r) => r && !seen.has(r.id)),
        ].sort((a, b) => b.finishedAt - a.finishedAt);
      }
      const storedRoutes = stored?.routes;
      if (storedRoutes && typeof storedRoutes === "object") {
        routes = { ...document.routes };
        for (const [id, storedProgress] of Object.entries(storedRoutes)) {
          const local = routes[id];
          if (!local) {
            routes[id] = storedProgress;
            continue;
          }
          const storedRevision = Number(storedProgress?.revision) || 0;
          if (storedRevision > local.revision)
            routes[id] = {
              ...storedProgress,
              drafts: { ...storedProgress.drafts, ...local.drafts },
            };
          else if (storedRevision === local.revision)
            routes[id] = {
              ...local,
              drafts: { ...storedProgress.drafts, ...local.drafts },
            };
        }
      }
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...document, records, routes }),
    );
    return true;
  } catch {
    return false;
  }
}
export type CommitResult = "committed" | "conflict" | "error";
// 路线奖励的事务提交：版本一致且完成记录未被他线归属时才落库，
// 否则由调用方把这次迟到提交保留为草稿，绝不同时发放互斥奖励。
export function commitRoutes(
  routeId: string,
  next: RouteProgress,
  baseRevision: number,
): CommitResult {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as GameDocument) : null;
    const storedRoutes =
      stored && typeof stored === "object" && stored.routes ? stored.routes : {};
    const current = storedRoutes[routeId];
    if ((Number(current?.revision) || 0) !== baseRevision) return "conflict";
    const taken = new Set<string>();
    for (const [id, progress] of Object.entries(storedRoutes)) {
      if (id === routeId || !progress) continue;
      for (const claim of Object.values(progress.claims ?? {}))
        taken.add((claim as NodeClaim).recordId);
      for (const recordId of progress.attributed ?? []) taken.add(recordId);
    }
    if (Object.values(next.claims).some((c) => taken.has(c.recordId)))
      return "conflict";
    const base =
      stored && typeof stored === "object"
        ? stored
        : { version: 1, activeId: "", sessions: {}, records: [] };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...base,
        routes: { ...storedRoutes, [routeId]: next },
      }),
    );
    return "committed";
  } catch {
    return "error";
  }
}
// 冲突后的草稿尽力落库（不改变 revision，只并入 drafts）。
export function attachStoredDraft(
  routeId: string,
  nodeId: string,
  draft: NodeDraft,
  expectedRevision: number,
): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const stored = JSON.parse(raw) as GameDocument;
    const current = stored?.routes?.[routeId];
    if (!current || (Number(current.revision) || 0) !== expectedRevision)
      return false;
    const merged = {
      ...current,
      drafts: { ...current.drafts, [nodeId]: draft },
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...stored,
        routes: { ...stored.routes, [routeId]: merged },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
// 读取存储中的路线进度（经版本校验），供跨窗口同步与冲突兜底。
export function readStoredRoutes(
  puzzles: Puzzle[],
): Record<string, RouteProgress> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as GameDocument;
    if (!data || typeof data !== "object") return null;
    return normalizeRoutes(
      storyRoutes,
      puzzles,
      data.routes && typeof data.routes === "object" ? data.routes : {},
      Array.isArray(data.records) ? data.records : [],
    );
  } catch {
    return null;
  }
}
