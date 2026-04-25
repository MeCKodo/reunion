import * as React from "react";
import { Plus, Tag, X } from "lucide-react";

interface SessionTagEditorProps {
  tags: string[];
  tagInput: string;
  setTagInput: (value: string) => void;
  onAddTag: (value: string) => boolean;
  onRemoveTag: (value: string) => void;
}

function SessionTagEditor({
  tags,
  tagInput,
  setTagInput,
  onAddTag,
  onRemoveTag,
}: SessionTagEditorProps) {
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

  const hasTags = tags.length > 0;

  // Compact placeholder so it can sit inline next to metadata badges without
  // dominating the row. Hover hint preserves the original prompt for users
  // unfamiliar with the icon-only affordance.
  if (!hasTags && !editing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        title="Add tag to organize this session"
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong/80 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent"
      >
        <Tag className="h-3 w-3" />
        Add tag
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="group inline-flex items-center gap-1 rounded-full bg-accent-soft/70 pl-2 pr-1 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
        >
          #{tag}
          <button
            type="button"
            onClick={() => onRemoveTag(tag)}
            className="rounded-full p-0.5 text-accent/40 transition-colors hover:bg-accent/10 hover:text-destructive"
            title="Remove tag"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

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
            placeholder="type then Enter"
            className="h-5 w-28 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border-strong/80 text-muted-foreground transition-colors hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent"
          title="Add another tag"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export { SessionTagEditor };
