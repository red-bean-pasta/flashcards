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
  updatedAt: string;
}
