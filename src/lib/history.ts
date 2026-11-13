export interface HistoryEntry {
  id: string;
  timestamp: Date;
  action: 'add' | 'remove' | 'edit';
  question: string;
  answer: string;
  status: 'applying' | 'retrying' | 'reviewing' | 'waiting' | 'queued' | 'disconnected' | 'needs-review' | 'success';
  error?: string;
  retryAt?: number;
  canDismiss?: boolean;
  canReview?: boolean;
  reconnect?: boolean;
}
