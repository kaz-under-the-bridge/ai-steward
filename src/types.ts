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
  | 'permission_request'
  | 'result'
  | 'error';

// control_request (can_use_tool) の構造化データ
export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  // CLIが提示する許可ルール候補（「今後も許可」応答のupdatedPermissionsに使う）
  suggestions: unknown[];
}

export interface StreamEvent {
  sessionId: string;
  type: StreamEventType;
  content: string;
  raw: Record<string, unknown>;
  timestamp: Date;
  permission?: PermissionRequestData;
}

// 承認ボタンアクション
export interface ApprovalAction {
  channelId: string;
  threadTs: string;
  userId: string;
  actionId: 'approve' | 'approve_always' | 'reject';
  // "sessionId:requestId" 形式（1セッション中に承認要求が複数回発生するため）
  approvalKey: string;
}

// CLIセッション
export interface CliSession {
  sessionId: string;
  claudeSessionId: string | null;
  pid: number;
  createdAt: Date;
}
