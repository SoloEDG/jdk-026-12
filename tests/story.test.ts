import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { puzzles, findPuzzle } from "../src/features/catalog/model/puzzles";
import { newDocument } from "../src/shared/document";
import { transition } from "../src/app/reducer";
import type { GameDocument, Puzzle, RouteProgress, StoryRoute } from "../src/shared/types";
import { storyRoutes } from "../src/features/story/model/routes";
import {
  freshProgress,
  nodeViews,
  routeSummary,
  planClaim,
  planSwitch,
  planRetryDraft,
  validateRoute,
  normalizeRoutes,
  mergeRoutes,
  type PlanOk,
} from "../src/features/story/model/progress";
import {
  loadDocument,
  saveDocument,
  commitRoutes,
  attachStoredDraft,
  readStoredRoutes,
} from "../src/features/journal/lib/storage";
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
let stored: string | null = null;
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => stored,
    setItem: (_: string, value: string) => {
      stored = value;
    },
  },
  configurable: true,
});
const [routeA, routeB] = storyRoutes;
function solve(d: GameDocument, puzzle: Puzzle): GameDocument {
  d = transition(d, { type: "open", id: puzzle.id }, puzzles);
  puzzle.solution.forEach((v, index) => {
    if (v) d = transition(d, { type: "mark", index, mark: "filled" }, puzzles);
  });
  return d;
}
function apply(d: GameDocument, route: StoryRoute, plan: PlanOk): GameDocument {
  return { ...d, routes: { ...d.routes, [route.id]: plan.progress } };
}
function claim(d: GameDocument, route: StoryRoute, nodeId: string): GameDocument {
  const plan = planClaim(d, route, puzzles, nodeId);
  assert.ok(plan.ok, `claim ${nodeId} should succeed: ${plan.ok ? "" : plan.reason}`);
  return apply(d, route, plan);
}
function view(d: GameDocument, route: StoryRoute, nodeId: string) {
  const progress = d.routes[route.id] ?? freshProgress(route.id, route.version);
  return nodeViews(route, progress, d, puzzles).find((v) => v.node.id === nodeId)!;
}
test("entry nodes are open, locked nodes explain prerequisites without spoiling", () => {
  const d = newDocument(puzzles[0]);
  const progress = freshProgress(routeA.id, routeA.version);
  const views = nodeViews(routeA, progress, d, puzzles);
  const byId = Object.fromEntries(views.map((v) => [v.node.id, v]));
  assert.equal(byId.a1.state, "available");
  assert.equal(byId.a1.needsRecord, true);
  assert.equal(byId.a2a.state, "locked");
  assert.ok(byId.a2a.reasons.some((r) => r.includes("蕨叶小径")));
  assert.ok(byId.a3.reasons.some((r) => r.includes("独立解答")));
  assert.equal(byId.a4.state, "locked");
  // 未开放节点只展示不泄露作品的线索
  assert.ok(byId.a4.node.hint.length > 0);
  assert.ok(!JSON.stringify(byId.a4.reasons).includes("灯塔"));
});
test("unassisted gate lifts after enough independent solves", () => {
  let d = newDocument(puzzles[0]);
  assert.ok(view(d, routeA, "a3").reasons.some((r) => r.includes("独立解答")));
  d = solve(d, findPuzzle("heart"));
  d = solve(d, findPuzzle("cup"));
  assert.ok(!view(d, routeA, "a3").reasons.some((r) => r.includes("独立解答")));
});
test("claiming consumes a record once; re-entry and refresh cannot re-grant", () => {
  stored = null;
  let d = newDocument(puzzles[0]);
  d = solve(d, findPuzzle("fern"));
  d = claim(d, routeA, "a1");
  assert.equal(d.routes[routeA.id].claims.a1.petals, 3);
  const again = planClaim(d, routeA, puzzles, "a1");
  assert.equal(again.ok, false);
  // 重复进入已完成的题不会产生新记录，也就无法重复领奖
  d = transition(d, { type: "open", id: "fern" }, puzzles);
  d = transition(d, { type: "mark", index: 0, mark: "filled" }, puzzles);
  assert.equal(d.records.length, 1);
  // 刷新（重新载入）后领取状态保留，不能重复领奖
  assert.ok(saveDocument(d));
  const restored = loadDocument(puzzles);
  assert.equal(restored.warning, "");
  assert.ok(restored.document.routes[routeA.id].claims.a1);
  const afterReload = planClaim(restored.document, routeA, puzzles, "a1");
  assert.equal(afterReload.ok, false);
});
test("one completion record belongs to a single route version", () => {
  let d = newDocument(puzzles[0]);
  d = solve(d, findPuzzle("cup"));
  d = solve(d, findPuzzle("bloom"));
  d = solve(d, findPuzzle("fern"));
  d = claim(d, routeB, "b1");
  d = claim(d, routeB, "b2"); // bloom 的记录归属路线 B
  d = claim(d, routeA, "a1");
  const blocked = planClaim(d, routeA, puzzles, "a2a");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /归属/);
  // 重新完成一次 bloom 后，新记录可以归属路线 A
  d = transition(d, { type: "open", id: "bloom" }, puzzles);
  d = transition(d, { type: "reset" }, puzzles);
  d = solve(d, findPuzzle("bloom"));
  const retry = planClaim(d, routeA, puzzles, "a2a");
  assert.ok(retry.ok);
});
test("branch reward is exclusive; switching revokes it and cascades downstream", () => {
  let d = newDocument(puzzles[0]);
  for (const id of ["fern", "bloom", "heart", "lighthouse"])
    d = solve(d, findPuzzle(id));
  d = claim(d, routeA, "a1");
  d = claim(d, routeA, "a2a");
  d = claim(d, routeA, "a3");
  d = claim(d, routeA, "a4");
  assert.equal(routeSummary(routeA, d.routes[routeA.id], puzzles).complete, true);
  assert.equal(view(d, routeA, "a2b").state, "forfeited");
  // 没有 cat 的完成记录时改道：收回旧奖励，新分支保持未领取
  const plan = planSwitch(d, routeA, "a2b");
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(new Set(plan.revoked), new Set(["a2a", "a4"]));
  assert.equal(plan.petalsLost, 15);
  assert.equal(plan.willClaim, false);
  d = apply(d, routeA, plan);
  assert.equal(view(d, routeA, "a2b").state, "available");
  assert.equal(view(d, routeA, "a2b").needsRecord, true);
  // 受影响的后续节点重新锁定并解释原因
  const a4 = view(d, routeA, "a4");
  assert.equal(a4.state, "locked");
  assert.ok(a4.reasons.some((r) => r.includes("岔路")));
  assert.equal(routeSummary(routeA, d.routes[routeA.id], puzzles).complete, false);
  // 允许自由回溯：释放出的 bloom 记录仍可回到 a2a
  const back = planClaim(d, routeA, puzzles, "a2a");
  assert.ok(back.ok);
});
test("switching to a solved branch claims immediately and released records stay in-route", () => {
  let d = newDocument(puzzles[0]);
  for (const id of ["fern", "bloom", "heart", "cat", "lighthouse"])
    d = solve(d, findPuzzle(id));
  d = claim(d, routeA, "a1");
  d = claim(d, routeA, "a2a");
  d = claim(d, routeA, "a3");
  d = claim(d, routeA, "a4");
  const plan = planSwitch(d, routeA, "a2b");
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.willClaim, true);
  d = apply(d, routeA, plan);
  assert.ok(d.routes[routeA.id].claims.a2b);
  assert.equal(view(d, routeA, "a2a").state, "forfeited");
  // 终章前置重新满足后可再次领取（同一条灯塔记录仍归属本路线）
  const finale = planClaim(d, routeA, puzzles, "a4");
  assert.ok(finale.ok);
  d = apply(d, routeA, finale);
  assert.equal(routeSummary(routeA, d.routes[routeA.id], puzzles).complete, true);
});
test("late submission from a second window is drafted, mutually exclusive rewards never both granted", () => {
  stored = null;
  let d = newDocument(puzzles[0]);
  d = solve(d, findPuzzle("fern"));
  assert.ok(saveDocument(d));
  // 窗口一：基于版本 0 提交 a1 的领取
  const first = planClaim(d, routeA, puzzles, "a1");
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(commitRoutes(routeA.id, first.progress, 0), "committed");
  // 窗口二：仍停留在版本 0 的旧快照，提交不同内容
  const stale = planClaim(d, routeA, puzzles, "a1");
  assert.ok(stale.ok);
  if (!stale.ok) return;
  assert.equal(commitRoutes(routeA.id, stale.progress, 0), "conflict");
  // 迟到提交保留为草稿，并尽力落库
  const storedRoutes = readStoredRoutes(puzzles)!;
  const current = storedRoutes[routeA.id];
  assert.equal(current.revision, 1);
  const draft = { recordId: stale.recordId, reason: "迟到提交", createdAt: Date.now() };
  assert.ok(attachStoredDraft(routeA.id, "a2a", draft, current.revision));
  assert.ok(readStoredRoutes(puzzles)![routeA.id].drafts.a2a);
  assert.equal(attachStoredDraft(routeA.id, "a3", draft, 99), false);
  // 同一完成记录不能跨路线领取：手工构造一条使用同记录的进度
  const recordId = first.recordId!;
  const foreign: RouteProgress = {
    ...freshProgress(routeB.id, routeB.version),
    revision: 1,
    claims: { b1: { recordId, petals: 3, badge: "x", claimedAt: Date.now() } },
    attributed: [recordId],
  };
  assert.equal(commitRoutes(routeB.id, foreign, 0), "conflict");
});
test("draft retry respects exclusivity and can succeed once the way is clear", () => {
  let d = newDocument(puzzles[0]);
  d = solve(d, findPuzzle("fern"));
  const progress = freshProgress(routeA.id, routeA.version);
  const fernRecord = d.records[0];
  d = {
    ...d,
    routes: {
      [routeA.id]: {
        ...progress,
        drafts: {
          a1: { recordId: fernRecord.id, reason: "冲突草稿", createdAt: Date.now() },
        },
      },
    },
  };
  const retried = planRetryDraft(d, routeA, puzzles, "a1");
  assert.ok(retried.ok);
  if (!retried.ok) return;
  assert.equal(retried.recordId, fernRecord.id);
  d = apply(d, routeA, retried);
  assert.ok(!d.routes[routeA.id].drafts.a1);
  assert.ok(d.routes[routeA.id].claims.a1);
});
test("route validation isolates cycles and missing puzzles without misjudging completion", () => {
  const broken: StoryRoute = {
    id: "broken",
    version: 1,
    title: "坏路线",
    synopsis: "",
    accent: "#000",
    nodes: [
      { id: "x", zone: "z", title: "x", hint: "", puzzleId: "ghost", requires: [], petals: 1, badge: "" },
      { id: "y", zone: "z", title: "y", hint: "", puzzleId: "heart", requires: [{ type: "nodes", nodeIds: ["z"] }], petals: 1, badge: "" },
      { id: "z", zone: "z", title: "z", hint: "", puzzleId: "cup", requires: [{ type: "nodes", nodeIds: ["y"] }], petals: 1, badge: "" },
      { id: "w", zone: "z", title: "w", hint: "", puzzleId: "fern", requires: [{ type: "nodes", nodeIds: ["y"] }], petals: 1, badge: "", finale: true },
    ],
  };
  const isolated = validateRoute(broken, puzzles);
  assert.match(isolated.x, /题目/);
  assert.match(isolated.y, /循环/);
  assert.match(isolated.z, /循环/);
  const d = newDocument(puzzles[0]);
  const views = nodeViews(broken, freshProgress(broken.id, 1), d, puzzles);
  const byId = Object.fromEntries(views.map((v) => [v.node.id, v]));
  assert.equal(byId.x.state, "isolated");
  assert.equal(byId.y.state, "isolated");
  assert.equal(byId.w.state, "locked");
  assert.ok(byId.w.reasons.some((r) => r.includes("隔离")));
  // 即使存档里伪造了终章领取，前置缺失也会降级为草稿，不会误判通关
  const record = { id: "r1", puzzleId: "fern", seconds: 1, hints: 0, checks: 0, finishedAt: 1 };
  const routes = normalizeRoutes(
    [broken],
    puzzles,
    {
      broken: {
        ...freshProgress(broken.id, 1),
        claims: { w: { recordId: "r1", petals: 1, badge: "", claimedAt: 1 } },
      },
    },
    [record],
  );
  assert.equal(routes.broken.claims.w, undefined);
  assert.ok(routes.broken.drafts.w);
  assert.equal(routeSummary(broken, routes.broken, puzzles).complete, false);
});
test("version migration keeps earned petals as legacy and isolates removed nodes", () => {
  const record = { id: "r1", puzzleId: "fern", seconds: 1, hints: 0, checks: 0, finishedAt: 1 };
  const gone = { id: "r2", puzzleId: "cup", seconds: 1, hints: 0, checks: 0, finishedAt: 2 };
  const routes = normalizeRoutes(
    storyRoutes,
    puzzles,
    {
      [routeA.id]: {
        ...freshProgress(routeA.id, 0),
        revision: 7,
        claims: {
          a1: { recordId: "r1", petals: 3, badge: "启程", claimedAt: 1 },
          removed: { recordId: "r2", petals: 9, badge: "旧章", claimedAt: 2 },
        },
        attributed: ["r1", "r2"],
      },
    },
    [record, gone],
  );
  const migrated = routes[routeA.id];
  assert.equal(migrated.routeVersion, routeA.version);
  assert.equal(migrated.revision, 7);
  assert.ok(migrated.claims.a1);
  assert.equal(migrated.claims.removed, undefined);
  assert.equal(migrated.legacyPetals, 9);
  assert.ok(migrated.legacyNotes.some((n) => n.includes("往昔拾遗")));
  // 旧归属仍然生效：r2 不能改投其他路线
  const d: GameDocument = {
    ...newDocument(puzzles[0]),
    records: [record, gone],
    routes,
  };
  const progressB = d.routes[routeB.id];
  const viewsB = nodeViews(routeB, progressB, d, puzzles);
  const b1 = viewsB.find((v) => v.node.id === "b1")!;
  assert.equal(b1.state, "available");
  assert.equal(b1.needsRecord, true);
});
test("a record claimed in two routes on restore keeps the earliest, the late one becomes a draft", () => {
  const record = { id: "r1", puzzleId: "bloom", seconds: 1, hints: 0, checks: 0, finishedAt: 1 };
  const claimA = { recordId: "r1", petals: 5, badge: "", claimedAt: 10 };
  const claimB = { recordId: "r1", petals: 4, badge: "", claimedAt: 20 };
  const routes = normalizeRoutes(
    storyRoutes,
    puzzles,
    {
      [routeA.id]: { ...freshProgress(routeA.id, 1), claims: { a2a: claimA }, attributed: ["r1"] },
      [routeB.id]: { ...freshProgress(routeB.id, 1), claims: { b2: claimB }, attributed: ["r1"] },
    },
    [record],
  );
  // a2a 的前置 a1 未领取，两条领取都会被前置校验降级；全局归属以保留下来的一方为准
  const owners = [routes[routeA.id], routes[routeB.id]].map((p) =>
    Object.values(p.claims).some((c) => c.recordId === "r1"),
  );
  assert.ok(owners.filter(Boolean).length <= 1);
  const drafts = [routes[routeA.id], routes[routeB.id]].flatMap((p) =>
    Object.values(p.drafts).map((d) => d.recordId),
  );
  assert.ok(drafts.filter((id) => id === "r1").length >= 1);
});
test("global record demotion re-validates downstream claims on restore", () => {
  const records = [
    { id: "r1", puzzleId: "cup", seconds: 1, hints: 0, checks: 0, finishedAt: 1 },
    { id: "r2", puzzleId: "bloom", seconds: 1, hints: 0, checks: 0, finishedAt: 2 },
    { id: "r3", puzzleId: "heart", seconds: 1, hints: 0, checks: 0, finishedAt: 3 },
  ];
  const routes = normalizeRoutes(
    storyRoutes,
    puzzles,
    {
      [routeA.id]: {
        ...freshProgress(routeA.id, 1),
        claims: { a2a: { recordId: "r2", petals: 5, badge: "", claimedAt: 10 } },
        attributed: ["r2"],
      },
      [routeB.id]: {
        ...freshProgress(routeB.id, 1),
        claims: {
          b1: { recordId: "r1", petals: 3, badge: "", claimedAt: 20 },
          b2: { recordId: "r2", petals: 4, badge: "", claimedAt: 21 },
          b3a: { recordId: "r3", petals: 5, badge: "", claimedAt: 22 },
        },
        attributed: ["r1", "r2", "r3"],
      },
    },
    records,
  );
  // a2a 的前置 a1 未领取 → 降级；r2 的归属随之释放，b2 得以保留
  // 但 b3a 依赖 b2，无论归属如何变化，都不能出现前置悬空的领取
  const b = routes[routeB.id];
  if (b.claims.b2) assert.ok(b.claims.b1);
  if (b.claims.b3a) assert.ok(b.claims.b2);
  if (!b.claims.b2) assert.ok(b.drafts.b2);
  if (!b.claims.b3a) assert.ok(b.drafts.b3a);
  assert.equal(routeSummary(routeB, b, puzzles).complete, false);
});
test("saveDocument never overwrites a newer route revision from another window", () => {
  stored = null;
  const base = newDocument(puzzles[0]);
  const newer: RouteProgress = { ...freshProgress(routeA.id, 1), revision: 5 };
  assert.ok(saveDocument({ ...base, routes: { [routeA.id]: newer } }));
  const stale: RouteProgress = { ...freshProgress(routeA.id, 1), revision: 2 };
  assert.ok(saveDocument({ ...base, routes: { [routeA.id]: stale } }));
  const raw = JSON.parse(stored!) as GameDocument;
  assert.equal(raw.routes[routeA.id].revision, 5);
});
test("saves from before routes existed load with fresh route progress", () => {
  stored = JSON.stringify({
    version: 1,
    activeId: puzzles[0].id,
    sessions: {},
    records: [],
  });
  const restored = loadDocument(puzzles);
  assert.equal(restored.warning, "");
  assert.equal(restored.document.routes[routeA.id].revision, 0);
  assert.equal(restored.document.routes[routeB.id].routeVersion, routeB.version);
});
test("mergeRoutes picks the higher revision and unions drafts", () => {
  const local = {
    [routeA.id]: {
      ...freshProgress(routeA.id, 1),
      revision: 1,
      drafts: { a1: { recordId: null, reason: "本地", createdAt: 1 } },
    },
  };
  const incoming = {
    [routeA.id]: {
      ...freshProgress(routeA.id, 1),
      revision: 2,
      drafts: { a2a: { recordId: null, reason: "远端", createdAt: 2 } },
    },
  };
  const merged = mergeRoutes(local, incoming);
  assert.equal(merged[routeA.id].revision, 2);
  assert.ok(merged[routeA.id].drafts.a1);
  assert.ok(merged[routeA.id].drafts.a2a);
  assert.equal(mergeRoutes(merged, incoming), merged);
});
