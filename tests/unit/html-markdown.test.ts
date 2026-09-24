// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, isPlainHtml } from '../../src/shared/html-markdown';

describe('htmlToMarkdown (rich text pasted into a note)', () => {
  it('keeps structure: headings, paragraphs, lists, to-dos, quotes, code, rules', () => {
    const html = `<meta charset="utf-8"><!--StartFragment-->
      <h2>Théorème de <em>Stokes</em></h2>
      <p>La <strong>circulation</strong> le long du bord<br>égale le <mark>flux</mark>.</p>
      <ul><li>Premier point<ul><li>détail</li></ul></li><li><input type="checkbox" checked> fait</li><li><input type="checkbox"> à faire</li></ul>
      <ol start="3"><li>trois</li><li>quatre</li></ol>
      <blockquote><p>Une citation</p></blockquote>
      <pre><code class="language-python">def f(x):\n    return x</code></pre>
      <hr><p>Du <code>code</code> et du <s>barré</s>.</p><!--EndFragment-->`;
    expect(htmlToMarkdown(html).markdown).toBe(
      [
        '## Théorème de *Stokes*',
        'La **circulation** le long du bord',
        'égale le ==flux==.',
        '- Premier point',
        '  - détail',
        '- [x] fait',
        '- [ ] à faire',
        '3. trois',
        '4. quatre',
        '> Une citation',
        '```python',
        'def f(x):',
        '    return x',
        '```',
        '---',
        'Du `code` et du ~~barré~~.',
      ].join('\n'),
    );
  });

  it('links, timecodes linked to their moment, and relative links resolved', () => {
    const html = '<p>Voir <a href="https://fr.wikipedia.org/wiki/Stokes">l’article</a>, <a href="/doc">la doc</a> et <a href="https://youtu.be/x?t=252"><code>04:12</code></a></p>';
    expect(htmlToMarkdown(html, 'https://cours.example.com/lecon/').markdown).toBe(
      'Voir [l’article](https://fr.wikipedia.org/wiki/Stokes), [la doc](https://cours.example.com/doc) et [04:12](https://youtu.be/x?t=252)',
    );
    // No usable address: the text alone.
    expect(htmlToMarkdown('<a href="javascript:alert(1)">clic</a>').markdown).toBe('clic');
  });

  it('reads Google Docs styles, and ignores its « not bold » wrapper', () => {
    const html =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Gras</span> <span style="font-style:italic">italique</span> <span style="text-decoration:line-through">barré</span> normal</p></b>';
    expect(htmlToMarkdown(html).markdown).toBe('**Gras** *italique* ~~barré~~ normal');
  });

  it('lists pictures as placeholders; videos, audios and embeds become links', () => {
    const html = `<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Schéma"> et <img src="https://cdn.example.com/a.jpg"></p>
      <img src="https://t.example.com/pixel.gif" width="1" height="1">
      <img src="blob:https://x/1" alt="locale">
      <figure><img src="/fig.png" alt="Figure 2"><figcaption>La figure</figcaption></figure>
      <video src="https://cdn.example.com/cours.mp4"></video>
      <audio><source src="https://cdn.example.com/podcast.mp3"></audio>
      <iframe src="https://www.youtube.com/embed/abcdefghijk?rel=0"></iframe>`;
    const { markdown, images } = htmlToMarkdown(html, 'https://site.example.com/');
    expect(images).toEqual([
      { token: 'boo-img:0', src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Schéma' },
      { token: 'boo-img:1', src: 'https://cdn.example.com/a.jpg', alt: '' },
      { token: 'boo-img:2', src: 'https://site.example.com/fig.png', alt: 'Figure 2' },
    ]);
    expect(markdown).toBe(
      [
        '![Schéma](boo-img:0) et ![](boo-img:1)',
        '*locale*',
        '![Figure 2](boo-img:2)',
        '*La figure*',
        '[▶ Vidéo](https://cdn.example.com/cours.mp4)',
        '[🔊 Audio](https://cdn.example.com/podcast.mp3)',
        '[▶ Vidéo YouTube](https://www.youtube.com/watch?v=abcdefghijk)',
      ].join('\n'),
    );
  });

  it('turns tables into Markdown tables', () => {
    const html = '<table><tr><th>Terme</th><th>Définition</th></tr><tr><td>DAG</td><td>graphe | orienté</td></tr></table>';
    expect(htmlToMarkdown(html).markdown).toBe('| Terme | Définition |\n| --- | --- |\n| DAG | graphe \\| orienté |');
  });

  it('tells plain HTML (a code editor, a text field) from formatted one', () => {
    expect(isPlainHtml('<div><span style="color:#569cd6">const</span> x = 1</div>')).toBe(true);
    expect(isPlainHtml('<p>du <b>gras</b></p>')).toBe(false);
    expect(isPlainHtml('<img src="x.png">')).toBe(false);
  });
});
