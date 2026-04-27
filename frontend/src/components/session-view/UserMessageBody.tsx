import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Bell,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/shared/Markdown";
import { ImageLightbox } from "@/components/shared/ImageLightbox";
import { ImageThumb } from "@/components/shared/ImageThumb";
import {
  assetUrl,
  basenameOf,
  extractImagePaths,
  extractInlineImageRefs,
} from "@/lib/asset";
import i18n from "@/i18n";

/**
 * Cursor / Claude inject several XML-shaped wrappers into the *first*
 * user message (skill prompts, attached image paths, system reminders).
 * The wrappers themselves are noise for a human reader. We collapse
 * known wrappers into a clickable chip and only render the wrapper's
 * payload on demand.
 *
 * `<user_query>` is the inverse case — it is the *real* user message
 * stripped of the injection scaffolding. We unwrap it so the actual
 * question reads as the body, not as a tag.
 */
const INJECTION_TAGS = new Set([
  "manually_attached_skills",
  "system_reminder",
  "system-reminder",
  "attached_files",
  "image_files",
  "available_skills",
  "available_tools",
  "previous_conversation_summary",
  "context_files",
  "open_and_recently_viewed_files",
]);

const STRIP_WRAPPERS = new Set(["user_query"]);

const TAG_LABEL_KEYS: Record<string, string> = {
  manually_attached_skills: "user.manuallyAttachedSkills",
  system_reminder: "user.systemReminder",
  "system-reminder": "user.systemReminder",
  attached_files: "user.attachedFiles",
  image_files: "user.imageFiles",
  available_skills: "user.availableSkills",
  available_tools: "user.availableTools",
  previous_conversation_summary: "user.previousConversationSummary",
  context_files: "user.contextFiles",
  open_and_recently_viewed_files: "user.openRecentFiles",
};

function getTagLabel(tag: string): string {
  const key = TAG_LABEL_KEYS[tag];
  return key ? i18n.t(key) : tag;
}

const TAG_ICON: Record<string, LucideIcon> = {
  manually_attached_skills: Sparkles,
  system_reminder: Bell,
  "system-reminder": Bell,
  attached_files: FileText,
  image_files: ImageIcon,
  available_skills: Wrench,
  available_tools: Wrench,
  previous_conversation_summary: FileText,
  context_files: FileText,
  open_and_recently_viewed_files: FileText,
};

interface InjectionSegment {
  kind: "injection";
  tag: string;
  raw: string;
  summary: string;
}

interface TextSegment {
  kind: "text";
  text: string;
}

type Segment = InjectionSegment | TextSegment;

const WRAPPER_RE = /<([\w-]+)>([\s\S]*?)<\/\1>/g;

function parseSkillNames(content: string): string[] {
  const names: string[] = [];
  const re = /^Skill Name:\s*(\S.*?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) names.push(m[1]);
  return names;
}

function countImagePaths(content: string): number {
  return content
    .split("\n")
    .filter((line) => /^\s*\d+\.\s*\//.test(line) || /^\s*\//.test(line))
    .length;
}

function summarize(tag: string, content: string): string {
  if (tag === "manually_attached_skills") {
    const names = parseSkillNames(content);
    if (names.length) {
      return names.length > 3
        ? `${names.slice(0, 3).join(", ")} +${names.length - 3}`
        : names.join(", ");
    }
    return i18n.t("user.skillInstructions");
  }
  if (tag === "image_files") {
    const n = countImagePaths(content);
    return n ? i18n.t("user.imageCount", { count: n }) : i18n.t("user.imageAttachment");
  }
  if (tag === "attached_files" || tag === "context_files") {
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.length
      ? i18n.t("user.fileCount", { count: lines.length })
      : i18n.t("user.file");
  }
  if (tag === "previous_conversation_summary") {
    const chars = content.trim().length;
    return chars
      ? i18n.t("user.chars", { count: chars.toLocaleString() })
      : i18n.t("user.summary");
  }
  return "";
}

export function parseUserMessage(text: string): Segment[] {
  const matches: { start: number; end: number; tag: string; content: string }[] = [];
  WRAPPER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WRAPPER_RE.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      tag: m[1],
      content: m[2],
    });
  }

  const interesting = matches.filter(
    (x) => INJECTION_TAGS.has(x.tag) || STRIP_WRAPPERS.has(x.tag)
  );
  const outer: typeof interesting = [];
  for (const x of interesting) {
    if (outer.some((o) => o.start < x.start && o.end > x.end)) continue;
    outer.push(x);
  }
  outer.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let pos = 0;
  for (const cut of outer) {
    if (cut.start > pos) {
      segments.push({ kind: "text", text: text.slice(pos, cut.start) });
    }
    if (STRIP_WRAPPERS.has(cut.tag)) {
      segments.push({ kind: "text", text: cut.content });
    } else {
      segments.push({
        kind: "injection",
        tag: cut.tag,
        raw: cut.content,
        summary: summarize(cut.tag, cut.content),
      });
    }
    pos = cut.end;
  }
  if (pos < text.length) {
    segments.push({ kind: "text", text: text.slice(pos) });
  }

  return segments;
}

interface InjectionChipProps {
  segment: InjectionSegment;
  queryTokens: string[];
}

function InjectionChip({ segment, queryTokens }: InjectionChipProps) {
  const matchesQuery =
    queryTokens.length > 0 &&
    queryTokens.some((t) =>
      segment.raw.toLowerCase().includes(t.toLowerCase())
    );

  // `image_files` is special — it carries actual pixels, not just metadata,
  // so it deserves a real attachment-card UI instead of the generic chip.
  if (segment.tag === "image_files") {
    return <ImageAttachmentCard raw={segment.raw} matchesQuery={matchesQuery} />;
  }

  return <PlainInjectionChip segment={segment} matchesQuery={matchesQuery} />;
}

interface PlainChipProps {
  segment: InjectionSegment;
  matchesQuery: boolean;
}

function PlainInjectionChip({ segment, matchesQuery }: PlainChipProps) {
  const [open, setOpen] = React.useState(false);
  const Icon = TAG_ICON[segment.tag] ?? Wrench;
  const label = getTagLabel(segment.tag);

  return (
    <div className="my-1.5 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
          "border-border bg-background-soft text-muted-foreground",
          "hover:border-primary/50 hover:bg-primary-soft/40 hover:text-foreground",
          open && "border-primary/40 bg-primary-soft/30 text-foreground",
          matchesQuery && !open && "border-accent/60 ring-1 ring-accent/30"
        )}
        aria-expanded={open}
      >
        <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />
        <span className="font-sans font-medium tracking-tight whitespace-nowrap">
          {label}
        </span>
        {segment.summary ? (
          <>
            <span className="opacity-40">·</span>
            <span className="truncate">{segment.summary}</span>
          </>
        ) : null}
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
          strokeWidth={2}
        />
      </button>

      {open ? (
        <pre className="max-h-[400px] overflow-auto rounded-md border border-border bg-background-soft px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-foreground/80 whitespace-pre-wrap break-words">
          {segment.raw.trim()}
        </pre>
      ) : null}
    </div>
  );
}

interface ImageAttachmentCardProps {
  raw: string;
  matchesQuery: boolean;
}

function ImageAttachmentCard({ raw, matchesQuery }: ImageAttachmentCardProps) {
  const { t } = useTranslation();
  const paths = React.useMemo(() => extractImagePaths(raw), [raw]);
  const [showRaw, setShowRaw] = React.useState(false);
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  // Couldn't recover any concrete paths — fall back to the generic chip so
  // the user still sees *something* and can expand to read the raw text.
  if (paths.length === 0) {
    return (
      <PlainInjectionChip
        segment={{
          kind: "injection",
          tag: "image_files",
          raw,
          summary: t("user.imageAttachment"),
        }}
        matchesQuery={matchesQuery}
      />
    );
  }

  const single = paths.length === 1;

  return (
    <div
      className={cn(
        "my-1.5 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70 shadow-sm",
        "transition-shadow hover:shadow-editorial",
        matchesQuery && "border-accent/60 ring-1 ring-accent/30"
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-background/40 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
        <ImageIcon className="h-3 w-3 shrink-0" strokeWidth={2} />
        <span className="font-sans font-medium tracking-tight text-foreground/75">
          {t("user.imageFiles")}
        </span>
        <span className="opacity-40">·</span>
        <span className="tabular-nums">{paths.length}</span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-overline transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
            showRaw
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground/55 hover:text-foreground"
          )}
          aria-pressed={showRaw}
        >
          raw
        </button>
      </div>

      <div className="p-2">
        {single ? (
          <SingleImageThumb path={paths[0]} onClick={() => setLightboxIndex(0)} />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {paths.map((path, index) => (
              <GridImageThumb
                key={path}
                path={path}
                onClick={() => setLightboxIndex(index)}
              />
            ))}
          </div>
        )}
      </div>

      {showRaw ? (
        <pre className="max-h-[260px] overflow-auto border-t border-border/40 bg-background-soft/60 px-3 py-2 font-mono text-[10.5px] leading-[1.55] text-muted-foreground whitespace-pre-wrap break-words">
          {raw.trim()}
        </pre>
      ) : null}

      <ImageLightbox
        paths={paths}
        initialIndex={lightboxIndex ?? 0}
        open={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  );
}

interface ThumbProps {
  path: string;
  onClick: () => void;
}

function SingleImageThumb({ path, onClick }: ThumbProps) {
  const [errored, setErrored] = React.useState(false);
  const name = basenameOf(path);

  if (errored) return <FallbackThumb path={path} onClick={onClick} large />;

  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      className={cn(
        "group/thumb relative block w-full cursor-zoom-in overflow-hidden rounded-md bg-background-soft/50",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      )}
    >
      <img
        src={assetUrl(path)}
        alt={name}
        loading="lazy"
        draggable={false}
        onError={() => setErrored(true)}
        className="block max-h-[240px] w-auto max-w-full object-contain"
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 translate-y-full",
          "bg-gradient-to-t from-black/70 via-black/40 to-transparent px-2.5 py-1.5",
          "font-mono text-[10.5px] text-white",
          "transition-transform duration-150 group-hover/thumb:translate-y-0"
        )}
      >
        <span className="block truncate">{name}</span>
      </div>
    </button>
  );
}

function GridImageThumb({ path, onClick }: ThumbProps) {
  const [errored, setErrored] = React.useState(false);
  const name = basenameOf(path);

  if (errored) return <FallbackThumb path={path} onClick={onClick} />;

  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      className={cn(
        "group/thumb relative h-20 w-20 cursor-zoom-in overflow-hidden rounded-md border border-border/60 bg-background-soft/50",
        "transition-all hover:border-primary/60 hover:shadow-editorial",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      )}
    >
      <img
        src={assetUrl(path)}
        alt={name}
        loading="lazy"
        draggable={false}
        onError={() => setErrored(true)}
        className="h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
      />
    </button>
  );
}

interface FallbackThumbProps extends ThumbProps {
  large?: boolean;
}

function FallbackThumb({ path, onClick, large = false }: FallbackThumbProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={basenameOf(path)}
      className={cn(
        "inline-flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-background-soft/40 text-muted-foreground transition-colors",
        "hover:border-primary/50 hover:text-foreground",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        large ? "h-28 w-full px-3 py-3" : "h-20 w-20"
      )}
    >
      <ImageIcon className={large ? "h-5 w-5" : "h-4 w-4"} />
      {large ? (
        <span className="max-w-full truncate font-mono text-[10px]">
          {basenameOf(path)}
        </span>
      ) : null}
    </button>
  );
}

interface TextWithInlineImagesProps {
  text: string;
  queryTokens: string[];
  keyPrefix: string;
}

/**
 * Render a text blob, lifting `[Image: source: /abs/path.png]` markers out
 * as real image previews. Claude CLI emits this textual form for clipboard
 * pastes whose temp file lives outside our allowed source roots — the
 * thumbnail's onError fallback handles the case where the file has since
 * been cleaned up.
 */
function TextWithInlineImages({
  text,
  queryTokens,
  keyPrefix,
}: TextWithInlineImagesProps) {
  const refs = React.useMemo(() => extractInlineImageRefs(text), [text]);
  if (refs.length === 0) {
    return <Markdown source={text} queryTokens={queryTokens} />;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  refs.forEach((ref, i) => {
    if (ref.start > cursor) {
      const slice = text.slice(cursor, ref.start);
      if (slice.trim()) {
        nodes.push(
          <Markdown
            key={`${keyPrefix}-md-${i}`}
            source={slice}
            queryTokens={queryTokens}
          />
        );
      }
    }
    nodes.push(
      <div key={`${keyPrefix}-img-${i}`} className="max-w-md">
        <ImageThumb source={{ kind: "path", path: ref.path }} />
      </div>
    );
    cursor = ref.end;
  });
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail.trim()) {
      nodes.push(
        <Markdown
          key={`${keyPrefix}-md-tail`}
          source={tail}
          queryTokens={queryTokens}
        />
      );
    }
  }
  return <div className="space-y-2">{nodes}</div>;
}

interface UserMessageBodyProps {
  text: string;
  queryTokens?: string[];
}

function UserMessageBody({ text, queryTokens = [] }: UserMessageBodyProps) {
  const { i18n } = useTranslation();
  const segments = React.useMemo(() => parseUserMessage(text), [text, i18n.language]);

  const hasInjection = segments.some((s) => s.kind === "injection");
  if (
    !hasInjection &&
    segments.length === 1 &&
    segments[0].kind === "text" &&
    segments[0].text === text
  ) {
    return (
      <TextWithInlineImages
        text={text}
        queryTokens={queryTokens}
        keyPrefix="root"
      />
    );
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          const trimmed = seg.text.trim();
          if (!trimmed) return null;
          return (
            <TextWithInlineImages
              key={`t-${i}`}
              text={trimmed}
              queryTokens={queryTokens}
              keyPrefix={`t-${i}`}
            />
          );
        }
        return (
          <InjectionChip
            key={`i-${i}`}
            segment={seg}
            queryTokens={queryTokens}
          />
        );
      })}
    </div>
  );
}

export { UserMessageBody };
