/**
 * Flashcards written in notes — the base of revision sheets, Anki decks and,
 * later, quizzes:
 *   `Question :: Réponse`                  one line;
 *   a line, then `?` alone, then the answer (until a blank line);
 *   `## Une question ?` heading, answered by what follows (until the next heading / blank line);
 *   `==mot==` in a line: a cloze card hiding that word.
 */
export interface Flashcard {
  id: string;
  noteId: string;
  type: 'basic' | 'cloze';
  front: string;
  back: string;
}


/** Anchors, links and emphasis made readable as plain text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/g, (_all, title: string, alias?: string) => alias ?? title)
    .replace(/(?<!!)\[((?:\d+:)?\d{1,3}:\d{2}(?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?)\](?:\([^()\s]*\))?/g, '$1')
    .replace(/(?<!!)\[(p\.\s?\d+|§\s?\d+)\](?:\(res:[^()\s]+\))?/g, '$1')
    .replace(/(?<!!)\[pin\s?(\d+)\](?:\(res:[^()\s]+\))?/gi, '◉ $1')
    .replace(/!\[[^\]\n]*\]\([^)\s]+\)/g, '')
    .replace(/(?<!!)\[([^\]\n]+)\]\((https?:[^()\s]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const LEADING_ANCHORS = /^(?:\[(?:(?:\d+:)?\d{1,3}:\d{2}(?:\s?[–-]\s?(?:\d+:)?\d{1,3}:\d{2})?|p\.\s?\d+|§\s?\d+|pin\s?\d+)\](?:\([^()\s]*\))?\s*)+/i;

/** Stable id of a card (same note, same question → same id), in Node and in browsers. */
function cardId(noteId: string, front: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const str = `${noteId}\n${front}`;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(12, '0').slice(-12);
}

/** Flashcards written in a note (see the syntax above). Code blocks are ignored. */
export function extractCards(noteId: string, markdown: string): Flashcard[] {
  const cards: Flashcard[] = [];
  const add = (type: Flashcard['type'], front: string, back: string) => {
    const f = front.trim();
    const b = back.trim();
    if (f && (b || type === 'cloze')) cards.push({ id: cardId(noteId, f), noteId, type, front: f, back: b });
  };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
      continue;
    }
    if (fence !== null || !line.trim()) continue;
    // The anchor that starts a note line ([04:15], [p. 12]…) is not part of the question.
    const content = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/, '').replace(LEADING_ANCHORS, '');
    // Question :: Réponse
    const inline = /^(.+?)\s::\s(.+)$/.exec(content);
    if (inline) {
      add('basic', plainText(inline[1]), plainText(inline[2]));
      continue;
    }
    // Question ?  /  ?  /  answer lines
    if (lines[i + 1]?.trim() === '?') {
      const answer: string[] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trim() !== ''; j++) answer.push(lines[j]);
      add('basic', plainText(content), plainText(answer.join('\n')));
      i = j;
      continue;
    }
    // ## Une question ?
    const heading = /^#{1,6}\s+(.+\?)\s*$/.exec(line);
    if (heading) {
      const answer: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      for (; j < lines.length && lines[j].trim() !== '' && !/^#{1,6}\s/.test(lines[j]); j++) answer.push(lines[j]);
      if (answer.length) add('basic', plainText(heading[1]), plainText(answer.join('\n')));
      continue;
    }
    // ==mot== : cloze
    if (/==[^=\n]+==/.test(content)) {
      let n = 0;
      const cloze = plainText(content.replace(/==([^=\n]+)==/g, (_all, word: string) => `{{c${++n}::${word}}}`));
      add('cloze', cloze, '');
    }
  }
  return cards;
}

