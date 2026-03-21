// Slackファイル添付
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url: string;       // url_private_download
}

// Slackイベント
export interface IncomingMessage {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  files: SlackFile[];
}

// stream-jsonイベント
export type StreamEventType =
  | 'init'
  | 'assistant_text'
  | 'tool_use'
  | 'permission_denied'
  | 'result'
  | 'error';

export interface StreamEvent {
  sessionId: string;
  type: StreamEventType;
  content: string;
  raw: Record<string, unknown>;
  timestamp: Date;
}

// 承認リクエスト
export interface ApprovalAction {
  channelId: string;
  threadTs: string;
  userId: string;
  actionId: 'approve' | 'reject';
  sessionId: string;
}

// CLIセッション
export interface CliSession {
  sessionId: string;
  claudeSessionId: string | null;
  pid: number;
  createdAt: Date;
}
