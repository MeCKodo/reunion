import type {
  ComposerMeta,
  DetailedTranscript,
  Session,
  SourceId,
  SubagentSessionDetail,
  TranscriptFileEntry,
} from "../types";

export interface SourceAdapter {
  readonly id: SourceId;
  readonly displayName: string;
  readonly rootDir: string;

  collectTranscriptFiles(): Promise<TranscriptFileEntry[]>;
  readTranscriptContent(filePath: string): Promise<string>;
  deriveTitle(content: string): string;
  loadDetailedTranscript(
    filePath: string,
    startedAt: number,
    updatedAt: number,
    sourcePrefix: string
  ): Promise<DetailedTranscript>;

  loadMetadata?(): Promise<Map<string, ComposerMeta>>;
  loadSubagentSessions?(parent: Session): Promise<SubagentSessionDetail[]>;
}
