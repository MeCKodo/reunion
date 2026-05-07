import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionDetail } from "@/lib/types";

type SessionBannerProps = {
  detail: SessionDetail;
  className?: string;
};

// Renders the team-mode disclaimers stacked on top of the session view. Hidden
// entirely for local sessions: there's no sampling, truncation, or missing
// tool-output story to tell. Multiple flags collapse into one card with a
// bullet list to keep the header compact.
export function SessionBanner({ detail, className }: SessionBannerProps) {
  const { t } = useTranslation();
  const isRemote = detail.provider === "remote";
  const hint = detail.hint;
  const messages: string[] = [];

  if (isRemote) messages.push(t("mode.banner.team"));
  if (hint?.message) messages.push(hint.message);
  if (hint?.sampled) messages.push(t("mode.banner.sampled"));
  if (hint?.truncated) messages.push(t("mode.banner.truncated"));
  if (hint?.missing_tool_results)
    messages.push(t("mode.banner.missingToolResults"));

  if (messages.length === 0) return null;

  return (
    <div
      role="note"
      className={cn(
        "rounded-md border border-primary/25 bg-primary-soft/40 px-3 py-2 text-xs text-foreground",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        {messages.length === 1 ? (
          <p className="leading-relaxed">{messages[0]}</p>
        ) : (
          <ul className="space-y-1 leading-relaxed">
            {messages.map((msg, idx) => (
              <li key={idx} className="list-disc list-inside">
                {msg}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
