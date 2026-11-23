import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Flag,
  Flower2,
  GitBranch,
  Lock,
  MapPin,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  GameDocument,
  Puzzle,
  RouteAction,
  StoryRoute,
} from "../../../shared/types";
import { storyRoutes } from "../model/routes";
import {
  freshProgress,
  nodeViews,
  planSwitch,
  routeSummary,
  type NodeView,
} from "../model/progress";
import { formatTime } from "../../journal/lib/summary";

const STATE_LABEL: Record<NodeView["state"], string> = {
  claimed: "已领取",
  available: "已开放",
  locked: "未开放",
  forfeited: "已让路",
  isolated: "已隔离",
};

function StateIcon({ view }: { view: NodeView }) {
  if (view.state === "claimed") return <Check size={15} />;
  if (view.state === "available") return <Sparkles size={15} />;
  if (view.state === "forfeited") return <GitBranch size={15} />;
  if (view.state === "isolated") return <AlertTriangle size={15} />;
  if (view.node.finale) return <Flag size={15} />;
  return <Lock size={14} />;
}

function groupZone(views: NodeView[]): NodeView[][] {
  const rows: NodeView[][] = [];
  for (const view of views) {
    const last = rows[rows.length - 1];
    if (
      view.node.branchGroup &&
      last &&
      last[0].node.branchGroup === view.node.branchGroup
    )
      last.push(view);
    else rows.push([view]);
  }
  return rows;
}

function NodeCard({
  view,
  route,
  document,
  puzzles,
  onRoute,
  onOpen,
  onSwitch,
}: {
  view: NodeView;
  route: StoryRoute;
  document: GameDocument;
  puzzles: Puzzle[];
  onRoute: (action: RouteAction) => void;
  onOpen: (id: string) => void;
  onSwitch: (nodeId: string) => void;
}) {
  const { node, state } = view;
  const puzzle = puzzles.find((p) => p.id === node.puzzleId);
  const claimRecord = view.claim
    ? document.records.find((r) => r.id === view.claim!.recordId)
    : undefined;
  return (
    <article className={`story-node ${state} ${view.draft ? "has-draft" : ""}`}>
      <span className="node-icon">
        <StateIcon view={view} />
      </span>
      <div className="node-body">
        <div className="node-title-row">
          <strong>{node.title}</strong>
          {node.finale && <span className="finale-tag">终章</span>}
          <span className={`node-state ${state}`}>{STATE_LABEL[state]}</span>
        </div>
        {state === "claimed" && view.claim ? (
          <>
            <p className="node-line">
              「{puzzle?.title}」已揭晓 · 花瓣 +{view.claim.petals} · 徽章「
              {view.claim.badge}」
            </p>
            {claimRecord && (
              <p className="node-sub">
                完成记录 {formatTime(claimRecord.seconds)} · 提示{" "}
                {claimRecord.hints} 次
              </p>
            )}
          </>
        ) : (
          <p className="node-hint">{node.hint}</p>
        )}
        {state === "available" && !view.draft && (
          <div className="node-actions">
            <span className="node-reward">
              <Flower2 size={12} /> +{node.petals} · 「{node.badge}」
            </span>
            {view.record ? (
              <>
                <button
                  className="primary"
                  onClick={() =>
                    onRoute({ type: "claim", routeId: route.id, nodeId: node.id })
                  }
                >
                  领取奖励
                </button>
                <small>将归属最早的一份完成记录 · {formatTime(view.record.seconds)}</small>
              </>
            ) : (
              <>
                <button onClick={() => onOpen(node.puzzleId)}>前往解谜</button>
                <small>
                  {view.hasRecords
                    ? "该题的完成记录已归属其他路线或节点，重新完成一次即可在此领取。"
                    : "完成后回到这里，把记录归属给这条路线。"}
                </small>
              </>
            )}
          </div>
        )}
        {state === "locked" && (
          <ul className="node-reasons">
            {view.reasons.map((reason) => (
              <li key={reason}>
                <Lock size={11} /> {reason}
              </li>
            ))}
          </ul>
        )}
        {state === "forfeited" && (
          <div className="node-actions">
            <ul className="node-reasons">
              {view.reasons.map((reason) => (
                <li key={reason}>
                  <GitBranch size={11} /> {reason}
                </li>
              ))}
            </ul>
            {!view.draft && (
              <button onClick={() => onSwitch(node.id)}>改走这条</button>
            )}
          </div>
        )}
        {state === "isolated" && (
          <p className="node-sub isolated-reason">
            <AlertTriangle size={11} /> {view.reasons[0]}，不影响已保留的成绩。
          </p>
        )}
        {view.draft && (
          <div className="draft-banner">
            <p>
              <AlertTriangle size={12} /> 草稿 · {view.draft.reason}
            </p>
            <div>
              {state === "available" && (
                <button
                  onClick={() =>
                    onRoute({
                      type: "retryDraft",
                      routeId: route.id,
                      nodeId: node.id,
                    })
                  }
                >
                  <RefreshCw size={12} /> 重新提交
                </button>
              )}
              <button
                onClick={() =>
                  onRoute({
                    type: "discardDraft",
                    routeId: route.id,
                    nodeId: node.id,
                  })
                }
              >
                <Trash2 size={12} /> 放弃
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export function StoryPanel({
  document,
  puzzles,
  notice,
  onRoute,
  onOpen,
  onGallery,
}: {
  document: GameDocument;
  puzzles: Puzzle[];
  notice: string;
  onRoute: (action: RouteAction) => void;
  onOpen: (id: string) => void;
  onGallery: () => void;
}) {
  const [routeId, setRouteId] = useState(storyRoutes[0].id);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const route = storyRoutes.find((r) => r.id === routeId) ?? storyRoutes[0];
  const progress =
    document.routes[route.id] ?? freshProgress(route.id, route.version);
  const views = nodeViews(route, progress, document, puzzles);
  const summary = routeSummary(route, progress, puzzles);
  const zones: { name: string; views: NodeView[] }[] = [];
  for (const view of views) {
    const zone = zones.find((z) => z.name === view.node.zone);
    if (zone) zone.views.push(view);
    else zones.push({ name: view.node.zone, views: [view] });
  }
  const preview =
    pendingSwitch != null
      ? planSwitch(document, route, pendingSwitch)
      : null;
  const previewNode = route.nodes.find((n) => n.id === pendingSwitch);
  const badges = views.filter((v) => v.state === "claimed" && v.claim);
  return (
    <section className="story panel">
      <div className="route-tabs">
        {storyRoutes.map((r) => (
          <button
            key={r.id}
            className={r.id === route.id ? "active" : ""}
            onClick={() => setRouteId(r.id)}
          >
            {r.title}
          </button>
        ))}
      </div>
      <div className="route-head">
        <div>
          <span className="eyebrow">
            STORY ROUTE · 版本 v{route.version}
          </span>
          <h1>{route.title}</h1>
          <p className="muted">{route.synopsis}</p>
        </div>
        <div className="route-stats">
          <span>
            <Flower2 size={14} />
            <strong>{summary.petals}</strong> 花瓣
          </span>
          <span>
            <strong>{summary.claimed}</strong> / {summary.total} 节点
          </span>
          <span>{summary.complete ? "已通关" : "进行中"}</span>
        </div>
      </div>
      <div className="route-progress">
        <span
          style={{
            width: `${summary.total ? Math.round((summary.claimed / summary.total) * 100) : 0}%`,
            background: route.accent,
          }}
        />
      </div>
      {badges.length > 0 && (
        <div className="badge-row">
          {badges.map((v) => (
            <span className="badge-chip" key={v.node.id}>
              {v.claim!.badge}
            </span>
          ))}
        </div>
      )}
      {notice && (
        <p className="story-notice" role="status">
          {notice}
        </p>
      )}
      {summary.isolatedCount > 0 && (
        <p className="route-warning">
          <AlertTriangle size={13} /> {summary.isolatedCount}{" "}
          个节点在校验中被隔离，已保留的成绩不受影响，路线不会被误判为通关。
        </p>
      )}
      {progress.legacyNotes.length > 0 && (
        <div className="legacy-notes">
          <span className="eyebrow">往昔拾遗 · 花瓣 {progress.legacyPetals}</span>
          {progress.legacyNotes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
      <div className="story-map">
        {zones.map((zone) => {
          const open = zone.views.some(
            (v) =>
              v.state === "claimed" ||
              v.state === "available" ||
              v.state === "forfeited" ||
              !!v.draft,
          );
          return (
            <section className={`zone-block ${open ? "open" : ""}`} key={zone.name}>
              <header className="zone-head">
                <MapPin size={13} />
                <strong>{zone.name}</strong>
                <span>{open ? "已开放" : "未开放"}</span>
              </header>
              <div className="zone-nodes">
                {groupZone(zone.views).map((row, index) =>
                  row.length > 1 ? (
                    <div className="branch-row" key={index}>
                      <span className="branch-label">
                        <GitBranch size={12} /> 岔路 · 二选一，奖励互斥
                      </span>
                      <div className="branch-cards">
                        {row.map((view) => (
                          <NodeCard
                            key={view.node.id}
                            view={view}
                            route={route}
                            document={document}
                            puzzles={puzzles}
                            onRoute={onRoute}
                            onOpen={onOpen}
                            onSwitch={setPendingSwitch}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <NodeCard
                      key={row[0].node.id}
                      view={row[0]}
                      route={route}
                      document={document}
                      puzzles={puzzles}
                      onRoute={onRoute}
                      onOpen={onOpen}
                      onSwitch={setPendingSwitch}
                    />
                  ),
                )}
              </div>
            </section>
          );
        })}
      </div>
      {summary.complete && (
        <div className="complete-banner">
          <Flag size={17} />
          <div>
            <strong>「{route.title}」已走完</strong>
            <p>终章作品已经揭晓，去展柜看看它真正的模样。</p>
          </div>
          <button onClick={onGallery}>
            打开展柜 <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      <p className="story-footnote">
        路线之间互不影响：同一道题可以被不同故事引用，但每份完成记录只能归属一条路线的一个版本。
      </p>
      {pendingSwitch != null && preview?.ok && previewNode && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-title"
          >
            <button
              className="modal-close"
              aria-label="再想想"
              onClick={() => setPendingSwitch(null)}
            >
              <X size={19} />
            </button>
            <h2 id="switch-title">改走「{previewNode.title}」？</h2>
            <p>
              将收回「
              {preview.revoked
                .map(
                  (id) => route.nodes.find((n) => n.id === id)?.title ?? id,
                )
                .join("」「")}
              」的奖励（花瓣 -{preview.petalsLost}）
              {preview.willClaim
                ? `，并立即领取新分支奖励（花瓣 +${previewNode.petals}）`
                : "。新分支还需要一份未归属的完成记录，完成后可领取"}
              。互斥奖励不会同时保留，受影响的后续节点会重新锁定并说明原因。
            </p>
            <div>
              <button onClick={() => setPendingSwitch(null)}>再想想</button>
              <button
                className="primary"
                onClick={() => {
                  onRoute({
                    type: "switchBranch",
                    routeId: route.id,
                    nodeId: pendingSwitch,
                  });
                  setPendingSwitch(null);
                }}
              >
                确认改道
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
