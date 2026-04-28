import * as React from "react";
import { useTranslation } from "react-i18next";
import { Copy, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useElectronDrag } from "@/hooks/useElectronDrag";
import { cn } from "@/lib/utils";
import { decodeEntities, formatDuration, formatTs, prettifyRepoName } from "@/lib/format";
import type { ExportKind } from "@/lib/api";
import type { SessionDetail, SourceId } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/types";
import { DeleteSessionButton } from "./DeleteSessionButton";
import { ExportActions } from "./ExportActions";
import { SessionTagEditor } from "./SessionTagEditor";

const SOURCE_BADGE_CLASS: Record<SourceId, string> = {
  cursor: "bg-muted text-muted-foreground",
  "claude-code": "bg-accent/15 text-accent",
  codex: "bg-muted text-muted-foreground",
};

interface SessionHeaderProps {
  detail: SessionDetail;

  onToggleStar: () => void;
  onCopySessionId: () => void;
  onExport: (kind: ExportKind) => void;
  exportLoading: "" | ExportKind;
  onDeleteSession: () => Promise<void>;

  tagInput: string;
  setTagInput: (value: string) => void;
  onAddTag: (value: string) => boolean;
  onRemoveTag: (tag: string) => void;
}

function SessionHeader({
  detail,
  onToggleStar,
  onCopySessionId,
  onExport,
  exportLoading,
  onDeleteSession,
  tagInput,
  setTagInput,
  onAddTag,
  onRemoveTag,
}: SessionHeaderProps) {
  const { t } = useTranslation();
  const repoLabel = prettifyRepoName(detail.repo);
  const fullTitle = decodeEntities(detail.title || detail.session_id);

  // Detect actual visual truncation so the tooltip only fires when there is
  // genuinely hidden content. Re-runs when the title or container size
  // changes (window resize, sidebar collapse, etc).
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const [titleTruncated, setTitleTruncated] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const update = () => setTitleTruncated(el.scrollWidth - el.clientWidth > 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullTitle]);

  // 让用户能从右侧顶栏的空白区域拖动整个窗口；按钮、标题、tag 编辑器
  // 等可交互元素再单独标记为 no-drag。
  const { dragStyle, noDragStyle } = useElectronDrag();

  return (
    <div
      className="shrink-0 border-b border-border bg-background px-4 py-2 sm:px-6 sm:py-2.5 space-y-1"
      style={dragStyle}
    >
      {/* Row 1: star + single-line title + action cluster.
          Title is hard-truncated to one line; the full string is exposed via
          a native tooltip so power users can hover to read the rest. */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onToggleStar}
          title={detail.starred ? t("session.unstar") : t("session.star")}
          style={noDragStyle}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors shrink-0",
            detail.starred
              ? "text-primary hover:bg-primary-soft/60"
              : "text-muted-foreground hover:text-foreground hover:bg-background-soft"
          )}
        >
          <Star className={cn("h-4 w-4", detail.starred && "fill-primary")} />
        </button>

        {/* The wrapper is the truncate container *and* the hover anchor for
            the custom tooltip. We deliberately omit the native `title`
            attribute: the browser's tooltip would race + stack on top of
            our instant React one. The full title is still in the DOM as
            visible text, so screen readers read it from the h1 directly.
            标题本身不是按钮，但仍需 no-drag 让用户可选中文字 / 触发 tooltip。 */}
        <div className="group/title relative min-w-0 flex-1" style={noDragStyle}>
          <h1
            ref={titleRef}
            className="truncate text-base leading-[1.3] font-semibold tracking-tight text-foreground sm:text-[17px]"
          >
            {fullTitle}
          </h1>
          {titleTruncated ? (
            <span
              role="tooltip"
              className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-max max-w-[min(48rem,90vw)] whitespace-normal rounded-md bg-foreground px-2.5 py-1.5 text-[12px] leading-snug text-background shadow-lg group-hover/title:block"
            >
              {fullTitle}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 shrink-0" style={noDragStyle}>
          <ExportActions onExport={onExport} loadingKind={exportLoading} />

          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onCopySessionId}
            title={t("session.copySessionId", { id: detail.session_id })}
          >
            <Copy className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{t("session.sessionId")}</span>
          </Button>

          <DeleteSessionButton title={fullTitle} onConfirm={onDeleteSession} />
        </div>
      </div>

      {/* Row 2: source + repo + time + tags, all on one wrappable line
          aligned beneath the title. Tag editor lives inline so it shares
          this row instead of taking its own. 整行 no-drag，避免 badge 上的
          hover tooltip / tag 编辑器被窗口拖拽事件吞掉。 */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 pl-9"
        style={noDragStyle}
      >
        <span
          className={cn(
            "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap",
            SOURCE_BADGE_CLASS[detail.source]
          )}
          title={detail.repo_path || `${SOURCE_LABEL[detail.source]} · ${detail.repo}`}
        >
          {SOURCE_LABEL[detail.source]}
        </span>
        <span
          className="inline-flex max-w-[16rem] items-center truncate rounded-sm bg-accent-soft/70 px-1.5 py-0.5 text-[10.5px] font-medium text-accent"
          title={detail.repo_path || detail.repo}
        >
          {repoLabel}
        </span>
        <span
          className="font-mono text-[11px] text-muted-foreground whitespace-nowrap"
          title={t("session.started", {
            time: formatTs(detail.started_at),
            duration: formatDuration(detail.duration_sec),
          })}
        >
          {formatTs(detail.started_at)}
          <span className="opacity-40"> · </span>
          {formatDuration(detail.duration_sec)}
        </span>

        {/* Subtle vertical separator so the tag editor reads as its own zone
            without breaking onto another line. */}
        <span aria-hidden className="hidden sm:inline-block h-3 w-px bg-border" />

        <SessionTagEditor
          tags={detail.tags ?? []}
          tagInput={tagInput}
          setTagInput={setTagInput}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          aiTags={detail.ai_tag_set}
          aiTaggedAt={detail.ai_tagged_at}
        />
      </div>
    </div>
  );
}

export { SessionHeader };
