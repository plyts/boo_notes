import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { markdownToBlocks, type BlockSpec, type RichText } from '../../src/shared/notion/blocks';
import { blocksHtml } from '../../src/shared/notion/html';
import { buildNotesPdf } from '../../src/shared/pdf-notes';
import { timestampUrl } from '../../src/shared/platforms';

/** Questions and free notes in the exports: Notion, the rich copy, the PDF. */

const URL1 = 'https://www.youtube.com/watch?v=abcdefghijk';

const MD = [
  '[00:03] Le professeur explique la différence entre X et Y.',
  '',
  '> [!question] Question 1 · [02:05]',
  '> Pourquoi cette méthode fonctionne-t-elle ?',
  '>',
  '> **Réponse :** Parce que les gradients restent bornés.',
  '>',
  '> **Source du cours — [00:14]**',
  '> « the gradients stay bounded »',
  '',
  '> [!note] Note libre',
  '> Me fait penser au cours 2.',
  '> > « Extrait du cours » [↗](https://c.test/l#:~:text=Extrait)',
  '> ![Capture](assets/a.png)',
];

const anchor = (_k: string, s: number) => ({ url: timestampUrl(URL1, s) });

describe('questions and free notes, exported', () => {
  it('Notion: a callout per block, its lines inside', () => {
    const blocks = markdownToBlocks(MD.join('\n'), { anchor });
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'callout', 'callout']);
    const [, q, free] = blocks as Array<Extract<BlockSpec, { rich: RichText[] }>>;
    expect(q.emoji).toBe('❓');
    expect(q.rich.map((r) => (r.type === 'text' ? r.text.content : '')).join('')).toBe('Question 1 · 02:05');
    // The moment it was asked links to the video.
    expect(q.rich.some((r) => r.type === 'text' && r.text.link?.url === `${URL1}#t=125`)).toBe(true);
    expect(q.children?.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(free.emoji).toBe('📝');
    expect(free.children?.map((b) => b.type)).toEqual(['paragraph', 'quote', 'image']);
  });

  it('rich copy: a titled quote holding its lines', () => {
    const html = blocksHtml(markdownToBlocks(MD.join('\n'), { anchor }), (p) => `data:${p}`);
    expect(html).toContain('<blockquote><p><strong>❓ </strong><strong>Question 1 · </strong>');
    expect(html).toContain('Pourquoi cette méthode fonctionne-t-elle ?');
    expect(html).toContain('<strong>📝 </strong><strong>Note libre</strong>');
    expect(html).toContain('<img src="data:assets/a.png"');
  });

  it('PDF: the blocks titled, their moments clickable, their pictures drawn', async () => {
    const bytes = await buildNotesPdf(
      [{ id: 'youtube:abcdefghijk', title: 'Cours', url: URL1, source: 'YouTube', place: null, updatedAt: Date.UTC(2026, 8, 30), markdown: MD.join('\n') }],
      {
        picture: async () => ({
          bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M9QzwAEjDAGNzYAAB0VAwFyX4bOAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0)),
          type: 'png',
        }),
        timeUrl: (_n, s) => timestampUrl(URL1, s),
      },
      { title: 'Cours', date: new Date(Date.UTC(2026, 8, 30)) },
    );
    const doc = await PDFDocument.load(bytes);
    const uris: string[] = [];
    let images = 0;
    for (const page of doc.getPages()) {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      for (let i = 0; i < (annots?.size() ?? 0); i++) {
        const action = annots!.lookup(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
        if (action) uris.push((action.lookup(PDFName.of('URI'), PDFString) as PDFString).decodeText());
      }
      images += page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0;
    }
    // Asked at 02:05, answered from 00:14; the quoted passage of the page.
    expect(uris).toContain(`${URL1}#t=125`);
    expect(uris).toContain(`${URL1}#t=14`);
    expect(uris).toContain('https://c.test/l#:~:text=Extrait');
    expect(images).toBe(1);
  });
});
