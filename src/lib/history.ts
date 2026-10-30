export interface HistoryEntry {
  id: string;
  timestamp: Date;
  action: 'add' | 'remove' | 'edit';
  question: string;
  answer: string;
  status: 'applying' | 'retrying' | 'reviewing' | 'waiting' | 'queued' | 'disconnected' | 'needs-review' | 'success' | 'failed';
  error?: string;
  retryAt?: number;
  canDismiss?: boolean;
  canReview?: boolean;
  source?: string;
  stage?: string;
  sourceBefore?: string | null;
  sourceAfter?: string;
  archiveBefore?: string | null;
  archiveAfter?: string;
}
