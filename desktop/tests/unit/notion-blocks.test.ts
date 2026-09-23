import { describe, expect, it } from 'vitest';
import { hashBlock, markdownToBlocks, notionLanguage, parseInline, toNotion } from '../../../src/shared/notion/blocks';
import { parseNotionId } from '../../../src/shared/notion/client';

describe('parseInline', () => {
  it('turns timestamps into code-styled links and page references into chips', () => {
    expect(parseInline('[04:15](https://www.youtube.com/watch?v=x#t=255) Le **hook** [p. 12]')).toEqual([
      {
        type: 'text',
        text: { content: '04:15', link: { url: 'https://www.youtube.com/watch?v=x#t=255' } },
        annotations: { code: true },
      },
      { type: 'text', text: { content: ' Le ' } },
      { type: 'text', text: { content: 'hook' }, annotations: { bold: true } },
      { type: 'text', text: { content: ' ' } },
      { type: 'text', text: { content: 'p. 12' }, annotations: { code: true } },
    ]);
  });

  it('handles links, emphasis, code and unsafe URLs', () => {
    const rich = parseInline('Voir [la *doc*](https://react.dev) et `useState` ~~non~~ [x](javascript:alert(1))');
    expect(rich).toContainEqual({
      type: 'text',
      text: { content: 'doc', link: { url: 'https://react.dev/' } },
      annotations: { italic: true },
    });
    expect(rich).toContainEqual({ type: 'text', text: { content: 'useState' }, annotations: { code: true } });
    expect(rich).toContainEqual({ type: 'text', text: { content: 'non' }, annotations: { strikethrough: true } });
    // Kept as text, never as a link.
    const links = rich.flatMap((r) => (r.type === 'text' && r.text.link ? [r.text.link.url] : []));
    expect(links).toEqual(['https://react.dev/', 'https://react.dev/']);
  });

  it('splits texts longer than Notion’s 2000 characters', () => {
    const rich = parseInline('a'.repeat(4500));
    expect(rich.map((r) => (r.type === 'text' ? r.text.content.length : 0))).toEqual([2000, 2000, 500]);
  });
});

describe('markdownToBlocks', () => {
  it('maps each line of a note to a block', () => {
    const md = [
      '# Hooks',
      '[00:05](https://y.test#t=5) Intro',
      '[00:09](https://y.test#t=9) Suite',
      '',
      '- point',
      '  - détail',
      '- [x] fait',
      '1. premier',
      '> citation',
      '> suite',
      '---',
      '```ts',
      'const a = 1;',
      '```',
      '[00:12](https://y.test#t=12) ![Capture 00:12](assets/cap-00-12.jpg)',
      '![schéma](https://img.test/a.png)',
    ].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_1',
      'paragraph',
      'paragraph',
      'bulleted_list_item',
      'to_do',
      'numbered_list_item',
      'quote',
      'divider',
      'code',
      'image',
      'external_image',
    ]);
    expect(blocks[3]).toMatchObject({ children: [{ type: 'bulleted_list_item' }] });
    expect(blocks[4]).toMatchObject({ checked: true });
    expect(blocks[6]).toMatchObject({ rich: [{ text: { content: 'citation\nsuite' } }] });
    expect(blocks[8]).toEqual({ type: 'code', text: 'const a = 1;', language: 'typescript' });
    expect(blocks[9]).toEqual({
      type: 'image',
      asset: 'assets/cap-00-12.jpg',
      caption: [{ type: 'text', text: { content: '00:12', link: { url: 'https://y.test/#t=12' } }, annotations: { code: true } }],
    });
  });

  it('produces valid Notion JSON, uploading captures', async () => {
    const [image, para] = markdownToBlocks('[00:12] ![Capture 00:12](assets/a.jpg)\n[p. 3] Lemme');
    expect(await toNotion(image, async () => 'upload-1')).toMatchObject({
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'upload-1' } },
    });
    expect(await toNotion(image, async () => null)).toMatchObject({ type: 'paragraph' });
    expect(await toNotion(para, async () => null)).toEqual({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: 'p. 3' }, annotations: { code: true } },
          { type: 'text', text: { content: ' Lemme' } },
        ],
      },
    });
  });

  it('fingerprints blocks by content', () => {
    const [a, b, c] = markdownToBlocks('x\ny\nx');
    expect(hashBlock(a)).toBe(hashBlock(c));
    expect(hashBlock(a)).not.toBe(hashBlock(b));
  });

  it('maps code languages to Notion’s list', () => {
    expect(notionLanguage('py')).toBe('python');
    expect(notionLanguage('C#')).toBe('c#');
    expect(notionLanguage('brainfuck')).toBe('plain text');
  });
});

describe('parseNotionId', () => {
  it('reads ids from links and raw ids', () => {
    const uuid = '0123abcd-0123-4567-89ab-0123456789ab';
    expect(parseNotionId('https://www.notion.so/acme/Mes-cours-0123abcd0123456789ab0123456789ab?pvs=4')).toBe(uuid);
    expect(parseNotionId('https://www.notion.so/acme/0123abcd0123456789ab0123456789ab?v=fff&p=aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(parseNotionId(uuid)).toBe(uuid);
    expect(parseNotionId('pas un lien')).toBeNull();
  });
});
