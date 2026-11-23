import type {
  GameDocument,
  NodeClaim,
  NodeDraft,
  NodeState,
  Puzzle,
  RouteProgress,
  SolveRecord,
  StoryNode,
  StoryRoute,
} from "../../../shared/types";

export function freshProgress(routeId: string, version: number): RouteProgress {
  return {
    routeId,
    routeVersion: version,
    revision: 0,
    claims: {},
    drafts: {},
    attributed: [],
    legacyPetals: 0,
    legacyNotes: [],
  };
}

function nodeDeps(node: StoryNode): string[] {
  return node.requires.flatMap((req) =>
    req.type === "unassisted" ? [] : req.nodeIds,
  );
}

// 静态校验：缺失题目、悬空前置、前置循环都会被隔离，隔离节点不参与通关判定。
export function validateRoute(
  route: StoryRoute,
  puzzles: Puzzle[],
): Record<string, string> {
  const isolated: Record<string, string> = {};
  const ids = new Set(route.nodes.map((n) => n.id));
  for (const node of route.nodes) {
    if (!puzzles.some((p) => p.id === node.puzzleId))
      isolated[node.id] = "引用的题目已不存在";
    for (const dep of nodeDeps(node))
      if (!ids.has(dep)) isolated[node.id] = "前置节点已不存在";
  }
  const edges = new Map(
    route.nodes.map((n) => [n.id, nodeDeps(n).filter((d) => ids.has(d))]),
  );
  const state = new Map<string, number>();
  const walk = (id: string, path: string[]) => {
    state.set(id, 1);
    for (const dep of edges.get(id) ?? []) {
      if (state.get(dep) === 1) {
        const cycle = [...path.slice(path.indexOf(dep)), id];
        for (const member of new Set(cycle))
          isolated[member] = "前置关系存在循环";
      } else if (!state.has(dep)) walk(dep, [...path, id]);
    }
    state.set(id, 2);
  };
  for (const node of route.nodes) if (!state.has(node.id)) walk(node.id, []);
  return isolated;
}

function unassistedCount(records: SolveRecord[]): number {
  return records.filter((r) => r.hints === 0).length;
}

function requirementMet(
  req: StoryNode["requires"][number],
  isClaimed: (id: string) => boolean,
  unassisted: number,
): boolean {
  if (req.type === "nodes") return req.nodeIds.every(isClaimed);
  if (req.type === "anyNode") return req.nodeIds.some(isClaimed);
  return unassisted >= req.count;
}

// 把未满足的前置翻译成玩家能读懂的锁定原因。
function requirementReasons(
  req: StoryNode["requires"][number],
  route: StoryRoute,
  isClaimed: (id: string) => boolean,
  unassisted: number,
  isolated: Record<string, string>,
): string[] {
  const title = (id: string) =>
    route.nodes.find((n) => n.id === id)?.title ?? id;
  if (req.type === "unassisted")
    return unassisted >= req.count
      ? []
      : [`需要累计 ${req.count} 次独立解答（当前 ${unassisted} 次）`];
  if (req.type === "anyNode") {
    if (req.nodeIds.some(isClaimed)) return [];
    return [
      `需要完成「${req.nodeIds.map(title).join("」或「")}」其中之一` +
        (req.nodeIds.some((id) => isolated[id]) ? "（部分前置已被隔离）" : ""),
    ];
  }
  const missing = req.nodeIds.filter((id) => !isClaimed(id));
  if (!missing.length) return [];
  return missing.map((id) =>
    isolated[id]
      ? `「${title(id)}」因${isolated[id]}被隔离，暂时无法通行`
      : `需要先完成「${title(id)}」`,
  );
}

// 一条完成记录在任意时刻只能归属一个路线版本：
// 已被领取（claims）的记录不可再用；曾经归属（attributed）的记录只能回到原路线。
export function pickRecord(
  document: GameDocument,
  route: StoryRoute,
  puzzleId: string,
): SolveRecord | null {
  const consumed = new Set<string>();
  const attributedElsewhere = new Set<string>();
  for (const [id, p] of Object.entries(document.routes)) {
    for (const claim of Object.values(p.claims)) consumed.add(claim.recordId);
    if (id !== route.id) for (const a of p.attributed) attributedElsewhere.add(a);
  }
  return (
    document.records
      .filter(
        (r) =>
          r.puzzleId === puzzleId &&
          !consumed.has(r.id) &&
          !attributedElsewhere.has(r.id),
      )
      .sort((a, b) => a.finishedAt - b.finishedAt)[0] ?? null
  );
}

export interface NodeView {
  node: StoryNode;
  state: NodeState;
  reasons: string[];
  claim?: NodeClaim;
  draft?: NodeDraft;
  record?: SolveRecord;
  needsRecord: boolean;
  hasRecords: boolean;
  groupPartner?: string;
}

export function nodeViews(
  route: StoryRoute,
  progress: RouteProgress,
  document: GameDocument,
  puzzles: Puzzle[],
): NodeView[] {
  const isolated = validateRoute(route, puzzles);
  const unassisted = unassistedCount(document.records);
  const isClaimed = (id: string) => !!progress.claims[id];
  return route.nodes.map((node) => {
    const claim = progress.claims[node.id];
    const draft = progress.drafts[node.id];
    const base = { node, draft, needsRecord: false, hasRecords: false };
    if (isolated[node.id])
      return { ...base, state: "isolated" as const, reasons: [isolated[node.id]], claim };
    if (claim) return { ...base, state: "claimed" as const, reasons: [], claim };
    if (node.branchGroup) {
      const rival = route.nodes.find(
        (n) =>
          n.id !== node.id &&
          n.branchGroup === node.branchGroup &&
          progress.claims[n.id],
      );
      if (rival)
        return {
          ...base,
          state: "forfeited" as const,
          reasons: [
            `已在「${rival.title}」领取奖励，同一条岔路只能带走一份纪念品。`,
          ],
          groupPartner: rival.title,
        };
    }
    const reasons = node.requires.flatMap((req) =>
      requirementReasons(req, route, isClaimed, unassisted, isolated),
    );
    if (reasons.length) return { ...base, state: "locked" as const, reasons };
    const record = pickRecord(document, route, node.puzzleId);
    return {
      ...base,
      state: "available" as const,
      reasons: [],
      record: record ?? undefined,
      needsRecord: !record,
      hasRecords: document.records.some((r) => r.puzzleId === node.puzzleId),
    };
  });
}

export function routeSummary(
  route: StoryRoute,
  progress: RouteProgress,
  puzzles: Puzzle[],
): {
  total: number;
  claimed: number;
  petals: number;
  complete: boolean;
  isolatedCount: number;
} {
  const isolated = validateRoute(route, puzzles);
  const valid = route.nodes.filter((n) => !isolated[n.id]);
  const finale = route.nodes.find((n) => n.finale);
  // 通关只认“终章节点已领取且有效”，隔离或前置缺失都不会误判为通关。
  const complete =
    !!finale && !isolated[finale.id] && !!progress.claims[finale.id];
  return {
    total: valid.length,
    claimed: valid.filter((n) => progress.claims[n.id]).length,
    petals:
      Object.values(progress.claims).reduce((sum, c) => sum + c.petals, 0) +
      progress.legacyPetals,
    complete,
    isolatedCount: route.nodes.length - valid.length,
  };
}

// 切换分支时级联收回：凡前置依赖被撤销节点的已领取节点，都一并收回。
export function cascadeRevoke(
  route: StoryRoute,
  claims: Record<string, NodeClaim>,
  rootId: string,
): string[] {
  const removed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of Object.keys(claims)) {
      if (removed.has(id)) continue;
      const node = route.nodes.find((n) => n.id === id);
      if (!node) continue;
      const ok = node.requires.every((req) =>
        req.type === "unassisted"
          ? true
          : req.type === "nodes"
            ? req.nodeIds.every((d) => !!claims[d] && !removed.has(d))
            : req.nodeIds.some((d) => !!claims[d] && !removed.has(d)),
      );
      if (!ok) {
        removed.add(id);
        grew = true;
      }
    }
  }
  return [...removed];
}

export interface PlanOk {
  ok: true;
  progress: RouteProgress;
  notice: string;
  recordId: string | null;
  revoked: string[];
  petalsLost: number;
  willClaim: boolean;
}
export interface PlanErr {
  ok: false;
  reason: string;
}
export type PlanResult = PlanOk | PlanErr;

const fail = (reason: string): PlanErr => ({ ok: false, reason });

function claimNode(
  progress: RouteProgress,
  node: StoryNode,
  recordId: string,
): RouteProgress {
  return {
    ...progress,
    revision: progress.revision + 1,
    claims: {
      ...progress.claims,
      [node.id]: {
        recordId,
        petals: node.petals,
        badge: node.badge,
        claimedAt: Date.now(),
      },
    },
    attributed: progress.attributed.includes(recordId)
      ? progress.attributed
      : [...progress.attributed, recordId],
  };
}

function viewOf(
  route: StoryRoute,
  progress: RouteProgress,
  document: GameDocument,
  puzzles: Puzzle[],
  nodeId: string,
): NodeView | undefined {
  return nodeViews(route, progress, document, puzzles).find(
    (v) => v.node.id === nodeId,
  );
}

export function planClaim(
  document: GameDocument,
  route: StoryRoute,
  puzzles: Puzzle[],
  nodeId: string,
): PlanResult {
  const progress = document.routes[route.id] ?? freshProgress(route.id, route.version);
  const view = viewOf(route, progress, document, puzzles, nodeId);
  if (!view) return fail("该节点不存在。");
  if (view.state === "claimed")
    return fail("该节点的奖励已经领取过了，重复进入不会重复领奖。");
  if (view.state === "isolated") return fail(view.reasons[0] ?? "节点已被隔离。");
  if (view.state === "forfeited")
    return fail("互斥分支的奖励已在手中，如需改道请使用「改走这条」。");
  if (view.state === "locked") return fail(view.reasons[0] ?? "节点尚未开放。");
  if (view.draft) return fail("该节点有一份待处理的草稿，请先处理草稿。");
  if (!view.record)
    return fail(
      view.hasRecords
        ? "该题的完成记录已归属其他路线或节点，重新完成一次可再获记录。"
        : "还没有可归属的完成记录，先完成这道题再来领取。",
    );
  const next = claimNode(progress, view.node, view.record.id);
  return {
    ok: true,
    progress: next,
    notice: `已领取「${view.node.title}」的奖励：花瓣 +${view.node.petals}，获得徽章「${view.node.badge}」。`,
    recordId: view.record.id,
    revoked: [],
    petalsLost: 0,
    willClaim: true,
  };
}

export function planSwitch(
  document: GameDocument,
  route: StoryRoute,
  nodeId: string,
): PlanResult {
  const progress = document.routes[route.id] ?? freshProgress(route.id, route.version);
  const node = route.nodes.find((n) => n.id === nodeId);
  if (!node?.branchGroup) return fail("该节点不在岔路中。");
  if (progress.claims[nodeId]) return fail("这条分支的奖励已经在手中了。");
  if (progress.drafts[nodeId]) return fail("该节点有一份待处理的草稿，请先处理草稿。");
  const rival = route.nodes.find(
    (n) =>
      n.id !== nodeId &&
      n.branchGroup === node.branchGroup &&
      progress.claims[n.id],
  );
  if (!rival) return fail("这条岔路还没有领取过奖励，直接领取即可。");
  const revoked = cascadeRevoke(route, progress.claims, rival.id);
  const claims = { ...progress.claims };
  let petalsLost = 0;
  for (const id of revoked) {
    petalsLost += claims[id]?.petals ?? 0;
    delete claims[id];
  }
  let next: RouteProgress = { ...progress, claims, revision: progress.revision + 1 };
  // 收回后，本路线释放出的完成记录可以重新归属，但全局互斥仍然生效。
  const previewDoc: GameDocument = {
    ...document,
    routes: { ...document.routes, [route.id]: next },
  };
  const record = pickRecord(previewDoc, route, node.puzzleId);
  const titles = revoked.map(
    (id) => route.nodes.find((n) => n.id === id)?.title ?? id,
  );
  let notice = `已改走「${node.title}」：收回「${titles.join("」「")}」的奖励（花瓣 -${petalsLost}）。`;
  if (record) {
    next = claimNode(next, node, record.id);
    notice += ` 同时领取新分支奖励：花瓣 +${node.petals}，获得徽章「${node.badge}」。`;
  } else {
    notice += " 新分支还需要一份未归属的完成记录，完成该题后即可领取。";
  }
  return {
    ok: true,
    progress: next,
    notice,
    recordId: record?.id ?? null,
    revoked,
    petalsLost,
    willClaim: !!record,
  };
}

export function planRetryDraft(
  document: GameDocument,
  route: StoryRoute,
  puzzles: Puzzle[],
  nodeId: string,
): PlanResult {
  const progress = document.routes[route.id] ?? freshProgress(route.id, route.version);
  const draft = progress.drafts[nodeId];
  if (!draft) return fail("该节点没有待提交的草稿。");
  const view = viewOf(route, progress, document, puzzles, nodeId);
  if (!view) return fail("该节点不存在。");
  if (view.state === "forfeited")
    return fail("互斥分支的奖励已被领取，这份草稿无法提交，可以放弃它。");
  if (view.state !== "available")
    return fail(view.reasons[0] ?? "节点当前不可领取。");
  const usable = (record: SolveRecord | undefined): record is SolveRecord =>
    !!record &&
    !Object.entries(document.routes).some(
      ([id, p]) =>
        id !== route.id &&
        (Object.values(p.claims).some((c) => c.recordId === record.id) ||
          p.attributed.includes(record.id)),
    ) &&
    !Object.values(progress.claims).some((c) => c.recordId === record.id);
  const drafted = draft.recordId
    ? document.records.find((r) => r.id === draft.recordId)
    : undefined;
  const record = usable(drafted) ? drafted : usable(view.record) ? view.record : null;
  if (!record)
    return fail("草稿中的完成记录已归属其他路线，需要一份新的完成记录。");
  const drafts = { ...progress.drafts };
  delete drafts[nodeId];
  const next = claimNode({ ...progress, drafts }, view.node, record.id);
  return {
    ok: true,
    progress: next,
    notice: `草稿已提交：领取「${view.node.title}」的奖励，花瓣 +${view.node.petals}。`,
    recordId: record.id,
    revoked: [],
    petalsLost: 0,
    willClaim: true,
  };
}

export function planDiscardDraft(
  document: GameDocument,
  route: StoryRoute,
  nodeId: string,
): PlanResult {
  const progress = document.routes[route.id] ?? freshProgress(route.id, route.version);
  if (!progress.drafts[nodeId]) return fail("该节点没有待处理的草稿。");
  const drafts = { ...progress.drafts };
  delete drafts[nodeId];
  return {
    ok: true,
    progress: { ...progress, drafts, revision: progress.revision + 1 },
    notice: "草稿已放弃，不会影响已领取的奖励。",
    recordId: null,
    revoked: [],
    petalsLost: 0,
    willClaim: false,
  };
}

// —— 存档恢复：按路线版本校验前置关系，隔离无效节点但保留成绩 ——

function validClaimShape(c: unknown): c is NodeClaim {
  const claim = c as NodeClaim;
  return (
    !!claim &&
    typeof claim.recordId === "string" &&
    Number.isFinite(claim.petals) &&
    Number.isFinite(claim.claimedAt)
  );
}

// 前置关系定点校验：前置领取缺失的节点降级为草稿，避免把路线误判为通关。
function demoteUnmetClaims(
  route: StoryRoute,
  claims: Record<string, NodeClaim>,
  drafts: Record<string, NodeDraft>,
  records: SolveRecord[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, claim] of Object.entries(claims)) {
      const node = route.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const ok = node.requires.every((req) =>
        requirementMet(req, (id) => !!claims[id], unassistedCount(records)),
      );
      if (!ok) {
        delete claims[nodeId];
        drafts[nodeId] ??= {
          recordId: claim.recordId,
          reason: "前置进度未满足，恢复时保留为待确认草稿。",
          createdAt: Date.now(),
        };
        changed = true;
      }
    }
  }
}

function normalizeOne(
  route: StoryRoute,
  puzzles: Puzzle[],
  stored: RouteProgress | undefined,
  records: SolveRecord[],
): RouteProgress {
  const fresh = freshProgress(route.id, route.version);
  if (!stored || typeof stored !== "object") return fresh;
  const isolated = validateRoute(route, puzzles);
  const migrated = stored.routeVersion !== route.version;
  const recordIds = new Set(records.map((r) => r.id));
  const claims: Record<string, NodeClaim> = {};
  const drafts: Record<string, NodeDraft> = {};
  const attributed = new Set(
    (stored.attributed ?? []).filter((a): a is string => typeof a === "string"),
  );
  let legacyPetals = Math.max(0, Number(stored.legacyPetals) || 0);
  const legacyNotes = (stored.legacyNotes ?? []).filter(
    (n): n is string => typeof n === "string",
  );
  const toLegacy = (petals: number, note: string) => {
    legacyPetals += Math.max(0, petals);
    legacyNotes.push(note + "奖励已保留为往昔拾遗。");
  };
  const entries = Object.entries(stored.claims ?? {})
    .filter((pair): pair is [string, NodeClaim] => validClaimShape(pair[1]))
    .sort((a, b) => a[1].claimedAt - b[1].claimedAt);
  const groupHolder = new Map<string, string>();
  for (const [nodeId, claim] of entries) {
    const node = route.nodes.find((n) => n.id === nodeId);
    if (!node) {
      toLegacy(claim.petals, `「${nodeId}」不在当前路线版本中。`);
      attributed.add(claim.recordId);
      continue;
    }
    if (isolated[nodeId]) {
      toLegacy(claim.petals, `「${node.title}」${isolated[nodeId]}，节点已隔离。`);
      attributed.add(claim.recordId);
      continue;
    }
    if (!recordIds.has(claim.recordId)) {
      toLegacy(claim.petals, `「${node.title}」对应的完成记录缺失。`);
      continue;
    }
    if (node.branchGroup) {
      const holder = groupHolder.get(node.branchGroup);
      if (holder) {
        drafts[nodeId] = {
          recordId: claim.recordId,
          reason: `与「${holder}」的奖励互斥${migrated ? "（版本迁移校验）" : ""}，恢复时保留为草稿。`,
          createdAt: Date.now(),
        };
        continue;
      }
      groupHolder.set(node.branchGroup, node.title);
    }
    claims[nodeId] = claim;
    attributed.add(claim.recordId);
  }
  // 前置关系定点校验：前置领取缺失的节点降级为草稿，避免把路线误判为通关。
  demoteUnmetClaims(route, claims, drafts, records);
  for (const [nodeId, draft] of Object.entries(stored.drafts ?? {})) {
    if (claims[nodeId] || drafts[nodeId]) continue;
    if (!route.nodes.some((n) => n.id === nodeId)) continue;
    if (!draft || typeof draft.reason !== "string") continue;
    drafts[nodeId] = {
      recordId: typeof draft.recordId === "string" ? draft.recordId : null,
      reason: draft.reason,
      createdAt: Number.isFinite(draft.createdAt) ? draft.createdAt : Date.now(),
    };
  }
  return {
    routeId: route.id,
    routeVersion: route.version,
    revision: Math.max(0, Number(stored.revision) || 0),
    claims,
    drafts,
    attributed: [...attributed],
    legacyPetals,
    legacyNotes,
  };
}

export function normalizeRoutes(
  routes: StoryRoute[],
  puzzles: Puzzle[],
  storedRoutes: Record<string, RouteProgress> | undefined,
  records: SolveRecord[],
): Record<string, RouteProgress> {
  const result: Record<string, RouteProgress> = {};
  for (const [id, progress] of Object.entries(storedRoutes ?? {}))
    if (!routes.some((r) => r.id === id) && progress && typeof progress === "object")
      result[id] = progress;
  for (const route of routes)
    result[route.id] = normalizeOne(route, puzzles, storedRoutes?.[route.id], records);
  // 全局校验：同一完成记录出现在多条路线的领取中时，晚到的领取降级为草稿。
  const owner = new Map<string, string>();
  const ordered = routes
    .flatMap((r) =>
      Object.entries(result[r.id].claims).map(([nodeId, claim]) => ({
        routeId: r.id,
        nodeId,
        claim,
      })),
    )
    .sort((a, b) => a.claim.claimedAt - b.claim.claimedAt);
  let demoted = false;
  for (const { routeId, nodeId, claim } of ordered) {
    const holder = owner.get(claim.recordId);
    if (holder && holder !== routeId) {
      delete result[routeId].claims[nodeId];
      result[routeId].drafts[nodeId] ??= {
        recordId: claim.recordId,
        reason: "该完成记录已归属另一条路线，恢复时保留为草稿。",
        createdAt: Date.now(),
      };
      demoted = true;
    } else owner.set(claim.recordId, routeId);
  }
  // 全局降级可能让同路线的后续领取悬空，需要再验证一轮前置关系。
  if (demoted)
    for (const route of routes)
      demoteUnmetClaims(
        route,
        result[route.id].claims,
        result[route.id].drafts,
        records,
      );
  return result;
}

// 跨窗口同步：每条路线取 revision 更高的一方，草稿取并集。
export function mergeRoutes(
  local: Record<string, RouteProgress>,
  incoming: Record<string, RouteProgress>,
): Record<string, RouteProgress> {
  let changed = false;
  const merged: Record<string, RouteProgress> = { ...local };
  for (const [id, next] of Object.entries(incoming)) {
    const current = merged[id];
    if (!current) {
      merged[id] = next;
      changed = true;
      continue;
    }
    const picked =
      next.revision > current.revision
        ? { ...next, drafts: { ...next.drafts, ...current.drafts } }
        : next.revision === current.revision
          ? { ...current, drafts: { ...next.drafts, ...current.drafts } }
          : current;
    if (JSON.stringify(picked) !== JSON.stringify(current)) {
      merged[id] = picked;
      changed = true;
    }
  }
  return changed ? merged : local;
}
