import { decodeEntities, sanitizeFileName, toPlainText } from "./lib/text";
import { parseTranscript } from "./transcript";
import type { ExportKind, ExportMode, ParsedSegment, Session } from "./types";
import { AiRouterError, runAiToString } from "./ai/router";
import type { AiProvider } from "./ai/settings";

function ensureSegments(session: Session): ParsedSegment[] {
  return session.segments.length > 0
    ? session.segments
    : parseTranscript(session.content, session.startedAt, session.updatedAt);
}

function extractConstraintLines(segments: ParsedSegment[]): string[] {
  const lines = segments
    .filter((segment) => segment.role === "user")
    .flatMap((segment) => decodeEntities(segment.text).split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 140);
  const picked = lines.filter((line) =>
    /(必须|需要|禁止|不要|优先|should|must|cannot|can't|avoid|require)/i.test(line)
  );
  return Array.from(new Set((picked.length ? picked : lines).slice(0, 8)));
}

function extractWorkflowLines(segments: ParsedSegment[]): string[] {
  const lines = segments
    .filter((segment) => segment.role === "assistant")
    .flatMap((segment) => decodeEntities(segment.text).split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 160);
  const picked = lines.filter((line) => /^(\d+[.)]|[-*])\s+/.test(line));
  return Array.from(new Set((picked.length ? picked : lines).slice(0, 8)));
}

export function buildRulesMarkdown(session: Session): string {
  const segments = ensureSegments(session);
  const title = toPlainText(session.title || session.sessionId);
  const userGoal = toPlainText(segments.find((segment) => segment.role === "user")?.text || "").slice(0, 400);
  const constraints = extractConstraintLines(segments);
  const workflow = extractWorkflowLines(segments);
  const updated = new Date(session.updatedAt * 1000).toISOString().slice(0, 10);

  return `# ${title} Rules

## Metadata
- source_repo: ${session.repo}
- source_session_key: ${session.sessionKey}
- updated: ${updated}

## Objective
${userGoal || "从该对话提炼执行规则。"}

## Rules
${constraints.length ? constraints.map((line) => `- ${line}`).join("\n") : "- 保持与用户需求一致，优先执行明确要求。"}

## Workflow
${workflow.length ? workflow.map((line) => `- ${line.replace(/^(\d+[.)]|[-*])\s+/, "")}`).join("\n") : "- 读取上下文 -> 制定方案 -> 执行并验证 -> 输出结果。"}

## Source Transcript
\`${session.filePath}\`
`;
}

export function buildSkillMarkdown(session: Session): string {
  const segments = ensureSegments(session);
  const title = toPlainText(session.title || session.sessionId);
  const userGoal = toPlainText(segments.find((segment) => segment.role === "user")?.text || "").slice(0, 260);
  const constraints = extractConstraintLines(segments);
  const workflow = extractWorkflowLines(segments);
  const safeName = sanitizeFileName(title).toLowerCase();

  return `---
name: ${safeName}
description: "${userGoal || `Derived from ${session.repo} conversation`}"
---

# ${title} Skill

## Purpose
${userGoal || "复用该对话中的执行能力与约束。"}

## When to Use
- 当需求与该对话目标相似时使用
- 需要复用同类流程、约束或产出结构时使用

## Inputs
- user request
- project context

## Constraints
${constraints.length ? constraints.map((line) => `- ${line}`).join("\n") : "- 遵循用户显式要求和仓库约束。"}

## Workflow
${workflow.length ? workflow.map((line, index) => `${index + 1}. ${line.replace(/^(\d+[.)]|[-*])\s+/, "")}`).join("\n") : "1. 读取上下文\n2. 设计最小可行方案\n3. 实施并验证\n4. 汇报结果"}

## Outputs
- 可执行修改
- 必要的验证结果

## Source Transcript
\`${session.filePath}\`
`;
}

export function stripCodeFence(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function buildSmartPrompt(session: Session, kind: ExportKind, fallbackMarkdown: string): string {
  const segments = ensureSegments(session);
  const compactTranscript = segments
    .slice(0, 24)
    .map((segment) => `[${segment.role}] ${toPlainText(segment.text).slice(0, 320)}`)
    .join("\n");
  const outputTarget = kind === "skill" ? "SKILL.md" : "RULES.md";
  const schemaHint =
    kind === "skill"
      ? `必须包含: frontmatter(name/description), # Title, ## Purpose, ## When to Use, ## Inputs, ## Constraints, ## Workflow, ## Outputs, ## Source Transcript`
      : `必须包含: # Title, ## Metadata, ## Objective, ## Rules, ## Workflow, ## Source Transcript`;

  return [
    `你是资深工程团队规范提炼助手。请把一次 Cursor 对话转成可复用的 ${outputTarget} 文档。`,
    `要求:`,
    `1) 输出纯 Markdown，不要代码围栏。`,
    `2) 内容必须可执行，避免空话。`,
    `3) ${schemaHint}`,
    `4) 优先保留用户约束、禁止项、验收标准。`,
    `5) 如果信息不足，用"待补充"明确标注，不要编造。`,
    ``,
    `上下文:`,
    `- repo: ${session.repo}`,
    `- session_key: ${session.sessionKey}`,
    `- title: ${toPlainText(session.title || session.sessionId)}`,
    `- source transcript path: ${session.filePath}`,
    ``,
    `对话片段(已压缩):`,
    compactTranscript,
    ``,
    `可参考的基础草稿(可重写，但结构需更优):`,
    fallbackMarkdown,
  ].join("\n");
}

export function isValidSmartMarkdown(kind: ExportKind, markdown: string): boolean {
  const text = markdown.toLowerCase();
  if (kind === "skill") {
    return (
      text.includes("## purpose") &&
      text.includes("## workflow") &&
      text.includes("## constraints") &&
      text.includes("## outputs")
    );
  }
  return text.includes("## objective") && text.includes("## rules") && text.includes("## workflow");
}

export interface GenerateExportOptions {
  /** Override provider; otherwise router uses settings.defaultProvider. */
  provider?: AiProvider;
  /** OpenAI account id to target (only meaningful when provider==='openai'). */
  accountId?: string;
}

export async function generateExportMarkdown(
  session: Session,
  kind: ExportKind,
  mode: ExportMode,
  options: GenerateExportOptions = {}
): Promise<{ markdown: string; mode: ExportMode; warning?: string }> {
  const fallback =
    kind === "skill" ? buildSkillMarkdown(session) : buildRulesMarkdown(session);
  if (mode !== "smart") {
    return { markdown: fallback, mode: "basic" };
  }
  try {
    const prompt = buildSmartPrompt(session, kind, fallback);
    const generated = stripCodeFence(
      await runAiToString({
        prompt,
        provider: options.provider,
        accountId: options.accountId,
      })
    );
    if (!generated || generated.length < 120 || !isValidSmartMarkdown(kind, generated)) {
      return {
        markdown: fallback,
        mode: "basic",
        warning: "smart generation returned low-confidence content, fallback applied",
      };
    }
    return { markdown: generated, mode: "smart" };
  } catch (error) {
    if (error instanceof AiRouterError) {
      return {
        markdown: fallback,
        mode: "basic",
        warning: `${error.code}: ${error.message}`,
      };
    }
    return { markdown: fallback, mode: "basic", warning: String(error) };
  }
}
