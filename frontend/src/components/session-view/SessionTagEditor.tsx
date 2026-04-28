import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Sparkles, Tag, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionTagEditorProps {
  tags: string[];
  tagInput: string;
  setTagInput: (value: string) => void;
  onAddTag: (value: string) => boolean;
  onRemoveTag: (value: string) => void;
  /** Subset of `tags` that came from the AI auto-tagger. */
  aiTags?: string[];
  /** Unix seconds; used in the AI tag tooltip. */
  aiTaggedAt?: number | null;
}

function SessionTagEditor({
  tags,
  tagInput,
  setTagInput,
  onAddTag,
  onRemoveTag,
  aiTags,
  aiTaggedAt,
}: SessionTagEditorProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const commitTag = () => {
    if (tagInput.trim()) {
      const ok = onAddTag(tagInput);
      if (ok) setTagInput("");
    }
  };

  const startEditing = () => {
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const aiTagSet = React.useMemo(() => new Set(aiTags || []), [aiTags]);
  const aiTooltip = React.useMemo(() => {
    if (typeof aiTaggedAt !== "number") return t("tags.aiTagBadge");
    const date = new Date(aiTaggedAt * 1000);
    if (Number.isNaN(date.getTime())) return t("tags.aiTagBadge");
    return t("tags.aiTagBadgeWithDate", { date: date.toISOString().slice(0, 10) });
  }, [aiTaggedAt, t]);

  const hasTags = tags.length > 0;

  // Compact placeholder so it can sit inline next to metadata badges without
  // dominating the row. Hover hint preserves the original prompt for users
  // unfamiliar with the icon-only affordance.
  if (!hasTags && !editing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        title={t("tags.addTag")}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong/80 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent"
      >
        <Tag className="h-3 w-3" />
        {t("tags.addTag")}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => {
        const isAi = aiTagSet.has(tag);
        return (
          <span
            key={tag}
            title={isAi ? aiTooltip : undefined}
            className={cn(
              "group inline-flex items-center gap-1 rounded-full pl-2 pr-1 py-0.5 text-xs font-medium transition-colors",
              isAi
                ? "bg-accent-soft/40 text-accent/85 ring-1 ring-inset ring-accent/20 hover:bg-accent-soft/60"
                : "bg-accent-soft/70 text-accent hover:bg-accent-soft"
            )}
          >
            {isAi ? <Sparkles className="h-2.5 w-2.5 opacity-80" /> : null}
            #{tag}
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              className="rounded-full p-0.5 text-accent/40 transition-colors hover:bg-accent/10 hover:text-destructive"
              title={t("tags.removeTag")}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}

      {editing ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft/40 px-2.5 py-0.5">
          <Tag className="h-3 w-3 shrink-0 text-accent/60" />
          <input
            ref={inputRef}
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitTag();
              } else if (event.key === "Escape") {
                setTagInput("");
                setEditing(false);
              } else if (event.key === "Backspace" && !tagInput && tags.length > 0) {
                const last = tags[tags.length - 1];
                if (last) onRemoveTag(last);
              }
            }}
            onBlur={() => {
              commitTag();
              setEditing(false);
            }}
            placeholder={t("tags.placeholder")}
            className="h-5 w-28 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border-strong/80 text-muted-foreground transition-colors hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent"
          title={t("tags.addAnother")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export { SessionTagEditor };
