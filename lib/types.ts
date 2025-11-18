export type KeywordSuggestion = {
  id: string;
  phrase: string;
  volume: number;
  cpc: number;
  difficulty: number;
  difficultyLabel?: string | null;
  idea?: string | null;
  language?: string | null;
  locationCode?: number | null;
};

export type TitleIdea = {
  id: string;
  text: string;
  keywords: string[];
  mood?: string;
};

export type ArticlePost = {
  id: string;
  title?: string;
  keyword?: string;
  keywordId?: string;
  content?: string;
  url?: string;
  categories?: string;
  status?: string;
};

export type KeywordTaskTicket = {
  id: number;
  status?: string | null;
};
