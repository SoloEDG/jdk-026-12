import { useEffect, useReducer, useState, useRef } from "react";
import { findPuzzle, puzzles } from "../features/catalog";
import { inspect, nextHint } from "../features/assist";
import {
  loadDocument,
  saveDocument,
  commitRoutes,
  attachStoredDraft,
  readStoredRoutes,
  STORAGE_KEY,
} from "../features/journal/lib/storage";
import { transition } from "./reducer";
import type { RouteAction } from "../shared/types";
import { findRoute } from "../features/story/model/routes";
import {
  freshProgress,
  planClaim,
  planSwitch,
  planRetryDraft,
  planDiscardDraft,
} from "../features/story/model/progress";
export function useGame() {
  const [initial] = useState(() => loadDocument(puzzles));
  const [document, dispatch] = useReducer(
    (d: typeof initial.document, a: Parameters<typeof transition>[1]) =>
      transition(d, a, puzzles),
    initial.document,
  );
  const [message, setMessage] = useState(initial.warning);
  const [routeNotice, setRouteNotice] = useState("");
  const [saveState, setSaveState] = useState(
    initial.warning ? "手动保存" : "进度已保存",
  );
  const allowSave = useRef(!initial.warning);
  const puzzle = findPuzzle(document.activeId);
  const session = document.sessions[puzzle.id];
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (globalThis.document.visibilityState === "visible")
        dispatch({ type: "tick" });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!allowSave.current) return;
    const timer = setTimeout(() => {
      const ok = saveDocument(document);
      setSaveState(ok ? "进度已保存" : "保存失败 · 点击重试");
      // 保存后对齐存储中的路线进度，避免本窗口长时间停留在旧版本。
      const stored = readStoredRoutes(puzzles);
      if (stored) dispatch({ type: "syncRoutes", routes: stored });
    }, 300);
    return () => clearTimeout(timer);
  }, [document]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const stored = readStoredRoutes(puzzles);
      if (stored) dispatch({ type: "syncRoutes", routes: stored });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const save = () => {
    allowSave.current = true;
    setSaveState(saveDocument(document) ? "进度已保存" : "保存失败 · 点击重试");
  };
  const hint = () => {
    const hint = nextHint(puzzle, session);
    if (hint) {
      dispatch({ type: "hint", ...hint });
      setMessage(
        `已揭示第 ${Math.floor(hint.index / puzzle.size) + 1} 行、第 ${(hint.index % puzzle.size) + 1} 列的一格。`,
      );
    } else setMessage("本题提示额度已用完，试试检查当前标记。");
  };
  const check = () => {
    const { errors } = inspect(puzzle, session);
    dispatch({ type: "check" });
    setMessage(
      errors
        ? `目前有 ${errors} 处标记与答案不符。检查不会直接揭示位置。`
        : "已填写的标记都正确，继续你的发现吧。",
    );
  };
  // 路线动作：先在内存中规划，再按版本事务提交；
  // 另一个窗口先提交时，本次提交保留为草稿，不发放互斥奖励。
  const route = (action: RouteAction) => {
    const def = findRoute(action.routeId);
    if (!def) return;
    const base =
      document.routes[def.id]?.revision ?? freshProgress(def.id, def.version).revision;
    const plan =
      action.type === "claim"
        ? planClaim(document, def, puzzles, action.nodeId)
        : action.type === "switchBranch"
          ? planSwitch(document, def, action.nodeId)
          : action.type === "retryDraft"
            ? planRetryDraft(document, def, puzzles, action.nodeId)
            : planDiscardDraft(document, def, action.nodeId);
    if (!plan.ok) {
      setRouteNotice(plan.reason);
      return;
    }
    const result = commitRoutes(def.id, plan.progress, base);
    if (result === "error") {
      setRouteNotice("保存失败，请稍后再试。");
      return;
    }
    if (result === "committed") {
      dispatch({
        type: "commitRoutes",
        routeId: def.id,
        progress: plan.progress,
      });
      setRouteNotice(plan.notice);
      return;
    }
    // 迟到提交：以存储中的新版本为准，本次尝试保留为草稿。
    const stored = readStoredRoutes(puzzles) ?? {};
    const current =
      stored[def.id] ?? document.routes[def.id] ?? freshProgress(def.id, def.version);
    if (action.type === "discardDraft") {
      // 放弃草稿本身不产生新草稿，直接对齐存储中的版本。
      dispatch({ type: "syncRoutes", routes: stored });
      setRouteNotice("另一个窗口已更新进度，已为你同步最新状态。");
      return;
    }
    const draft = {
      recordId: plan.recordId,
      reason: `另一个窗口已先一步提交（版本 ${current.revision}），本次提交按版本保留为草稿，未领取互斥奖励。`,
      createdAt: Date.now(),
    };
    attachStoredDraft(def.id, action.nodeId, draft, current.revision);
    dispatch({
      type: "commitRoutes",
      routeId: def.id,
      progress: {
        ...current,
        drafts: { ...current.drafts, [action.nodeId]: draft },
      },
    });
    setRouteNotice(draft.reason);
  };
  return {
    document,
    puzzle,
    session,
    message,
    saveState,
    routeNotice,
    dispatch,
    save,
    hint,
    check,
    route,
    clearMessage: () => setMessage(""),
    clearRouteNotice: () => setRouteNotice(""),
  };
}
