import * as cheerio from 'cheerio';

export interface TrendlyneChecklistItem {
  question: string;
  answer: boolean;
}

export interface TrendlyneChecklistResult {
  score: number;
  total: number;
  yesCount: number;
  insight?: string;
  checklistData: Record<string, TrendlyneChecklistItem[]>;
}

/**
 * Parses the server-rendered HTML from
 * https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/{tlid}
 * (despite the "clientapi" path segment, this returns HTML, not JSON).
 */
export function parseChecklistHtml(html: string): TrendlyneChecklistResult | null {
  const $ = cheerio.load(html);
  const checklistData: Record<string, TrendlyneChecklistItem[]> = {};
  let yesCount = 0;
  let total = 0;

  $('.checklist-content-header').each((_, headerEl) => {
    const $header = $(headerEl);
    // The category name is the header's own text; strip the nested count-badge
    // span (`.stock-checklist-header`) before reading it.
    const categoryName = $header.clone().find('span').remove().end().text().trim();
    if (!categoryName) return;

    const items: TrendlyneChecklistItem[] = [];
    const $block = $header.parent(); // div.p-y-1.col-xs-12 wrapping this category
    $block.find('.checklist-content-insight').each((_, insightEl) => {
      const $insight = $(insightEl);
      const question = $insight.find('.checklist-content-insight-question').text().trim();
      if (!question) return;
      const answerText = $insight.find('.sprite-checklist-check').text().trim().toUpperCase();
      const answer = answerText.includes('YES');
      items.push({ question, answer });
      total += 1;
      if (answer) yesCount += 1;
    });

    if (items.length > 0) {
      checklistData[categoryName] = items;
    }
  });

  if (total === 0) return null;

  return {
    score: Math.round((yesCount / total) * 1000) / 10,
    total,
    yesCount,
    checklistData,
  };
}
