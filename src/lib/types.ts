export interface Card {
  id: string;
  source: string;
  line: number;
  question: string;
  answer: string;
  questionHtml: string;
  answerHtml: string;
}
export interface DeckState {
  cards: Card[];
  files: string[];
  errors: string[];
  revisions: Record<string, string>;
}

export type MutationRequest = { source: string; revision: string | null } & (
  | { action: 'add'; question: string; answer: string }
  | { action: 'edit'; index: number; question: string; answer: string }
  | { action: 'remove'; index: number }
);
export type MutationResult = { source: string; revision: string; cards: Card[] };
