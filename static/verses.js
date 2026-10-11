// Finds spoken Bible references in transcript text ("John 3:16", "John three sixteen",
// "First Corinthians chapter 13 verses 4 through 7", "chapter 3 of Genesis verse 16")
// and builds NKJV links for them. VerseTracker keeps the tail of recent lines so a
// reference split across two transcript lines ("Genesis" ... "3:16") is still found.

const BOOKS = [
  // [canonical name, chapters, ...spoken aliases and common misspellings]
  ["Genesis", 50], ["Exodus", 40], ["Leviticus", 27], ["Numbers", 36],
  ["Deuteronomy", 34, "deuteronomie"], ["Joshua", 24], ["Judges", 21], ["Ruth", 4],
  ["1 Samuel", 31], ["2 Samuel", 24], ["1 Kings", 22], ["2 Kings", 25],
  ["1 Chronicles", 29], ["2 Chronicles", 36], ["Ezra", 10], ["Nehemiah", 13],
  ["Esther", 10], ["Job", 42], ["Psalm", 150, "psalms", "the psalms"], ["Proverbs", 31, "proverb"],
  ["Ecclesiastes", 12, "ecclesiastics"], ["Song of Solomon", 8, "song of songs", "songs of solomon"],
  ["Isaiah", 66], ["Jeremiah", 52], ["Lamentations", 5, "lamentation"],
  ["Ezekiel", 48, "ezekial"], ["Daniel", 12], ["Hosea", 14], ["Joel", 3], ["Amos", 9],
  ["Obadiah", 1], ["Jonah", 4], ["Micah", 7], ["Nahum", 3],
  ["Habakkuk", 3, "habakuk", "habbakuk"], ["Zephaniah", 3], ["Haggai", 2],
  ["Zechariah", 14, "zachariah"], ["Malachi", 4],
  ["Matthew", 28], ["Mark", 16], ["Luke", 24], ["John", 21],
  ["Acts", 28, "acts of the apostles"], ["Romans", 16], ["1 Corinthians", 16, "corinthian"],
  ["2 Corinthians", 13, "corinthian"], ["Galatians", 6, "galations"], ["Ephesians", 6],
  ["Philippians", 4, "phillipians", "philipians"], ["Colossians", 4],
  ["1 Thessalonians", 5, "thessalonian"], ["2 Thessalonians", 3, "thessalonian"],
  ["1 Timothy", 6], ["2 Timothy", 4], ["Titus", 3], ["Philemon", 1], ["Hebrews", 13],
  ["James", 5], ["1 Peter", 5], ["2 Peter", 3], ["1 John", 5], ["2 John", 1], ["3 John", 1],
  ["Jude", 1], ["Revelation", 22, "revelations"],
];

// Book names that are also everyday words ("my job 5 days a week", "numbers 1 to 10").
// These need a clear reference marker (chapter/verse/colon) or a capitalized name
// followed by both chapter and verse.
const AMBIGUOUS = new Set(["Numbers", "Job", "Mark", "Acts", "James", "Ruth", "Jude", "Titus"]);

const ORDINALS = {
  1: ["1", "1st", "first", "one", "i"],
  2: ["2", "2nd", "second", "two", "ii"],
  3: ["3", "3rd", "third", "three", "iii"],
};

// Spoken name (as a word list) -> book. Numbered books get every ordinal spelling;
// their aliases are the unnumbered part ("corinthian" -> "first corinthian").
const BOOK_PATTERNS = [];
for (const [name, chapters, ...aliases] of BOOKS) {
  const book = { name, chapters };
  const numbered = name.match(/^(\d) (.+)$/);
  for (const spoken of [numbered ? numbered[2] : name, ...aliases]) {
    const words = spoken.toLowerCase().split(" ");
    if (numbered) {
      for (const ord of ORDINALS[numbered[1]]) BOOK_PATTERNS.push({ words: [ord, ...words], book });
    } else {
      BOOK_PATTERNS.push({ words, book });
    }
  }
}
BOOK_PATTERNS.sort((a, b) => b.words.length - a.words.length); // longest match first

// Verses per chapter, {"John": [51, 25, 36, ...]}. Filled by setVerseCounts() from the
// server; until then verses are only checked against the longest chapter (176).
let verseCounts = null;
function setVerseCounts(counts) {
  verseCounts = counts;
}

const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ZERO_WORDS = new Set(["oh", "o", "zero"]);
const isNumberWord = (w) => w in ONES || w in TEENS || w in TENS || w === "hundred";

// Reads the tens-and-ones part of a number at tokens[j]: "twenty three", "sixteen", "four".
function readTens(tokens, j) {
  const w = tokens[j];
  if (w in TENS) return tokens[j + 1] in ONES ? [TENS[w] + ONES[tokens[j + 1]], 2] : [TENS[w], 1];
  if (w in TEENS) return [TEENS[w], 1];
  if (w in ONES) return [ONES[w], 1];
  return null;
}

// Reads one number at tokens[i] (digits or words). "three sixteen" reads as 3, then 16.
// "one oh five" reads as 105. With hundredsShorthand, "one nineteen" reads as 119
// (how people say Psalm numbers). Returns [value, tokensConsumed] or null.
function readNumber(tokens, i, hundredsShorthand = false) {
  const t = tokens[i];
  if (t === undefined) return null;
  if (/^\d+$/.test(t)) return [parseInt(t, 10), 1];

  if (t in ONES && ZERO_WORDS.has(tokens[i + 1]) && tokens[i + 2] in ONES) {
    return [ONES[t] * 100 + ONES[tokens[i + 2]], 3];
  }
  if (hundredsShorthand && t in ONES) {
    const rest = readTens(tokens, i + 1);
    if (rest && rest[0] >= 10) return [ONES[t] * 100 + rest[0], 1 + rest[1]];
  }

  let value = 0;
  let j = i;
  if (t in ONES && tokens[j + 1] === "hundred") {
    value = ONES[t] * 100;
    j += 2;
  } else if (t === "hundred" || (t === "a" && tokens[j + 1] === "hundred")) {
    value = 100;
    j += t === "a" ? 2 : 1;
  }
  if (value && tokens[j] === "and" && isNumberWord(tokens[j + 1] ?? "")) j++;
  const rest = readTens(tokens, j);
  if (rest) {
    value += rest[0];
    j += rest[1];
  }
  return j > i ? [value, j - i] : null;
}

function tokenize(text) {
  const tokens = [];
  const caps = []; // whether each token was capitalized in the transcript
  const cleaned = text
    .replace(/([A-Za-z])-([A-Za-z])/g, "$1 $2") // "twenty-three" -> "twenty three"
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 - $2") // "16-18" keeps the range marker
    .replace(/(\d)\.(\d)/g, "$1:$2") // "3.16" -> "3:16"
    .replace(/:/g, " : ");
  for (const raw of cleaned.split(/\s+/)) {
    const word = raw.replace(/^[^\w:-]+|[^\w:-]+$/g, "");
    if (!word) continue;
    tokens.push(word.toLowerCase());
    caps.push(/^[A-Z]/.test(word));
  }
  return { tokens, caps };
}

const VERSE_WORDS = new Set(["verse", "verses", "versus", "v", "vs"]);
const RANGE_WORDS = new Set(["-", "through", "thru", "to"]);
const FILLERS = new Set(["uh", "um", "uhm", "er", "erm", "ah", "hmm"]);

// Skips up to two filler words ("John, uh, 3:16").
function skipFillers(tokens, j) {
  for (let n = 0; n < 2 && FILLERS.has(tokens[j]); n++) j++;
  return j;
}

function matchBook(tokens, i) {
  for (const p of BOOK_PATTERNS) {
    if (p.words.every((w, k) => tokens[i + k] === w)) return { book: p.book, end: i + p.words.length };
  }
  return null;
}

// Skips "the book of" before a book name in "chapter 3 of the book of Genesis".
function skipBookOf(tokens, j) {
  if (tokens[j] === "the") j++;
  if (tokens[j] === "book" && tokens[j + 1] === "of") j += 2;
  return j;
}

// Reads "16", "16 through 18", or "16 and 17" at tokens[j].
function readVerses(tokens, j) {
  const v = readNumber(tokens, j);
  if (!v) return null;
  let end = j + v[1];
  let verseEnd = null;
  const w = tokens[end];
  if (RANGE_WORDS.has(w) || w === "and") {
    const v2 = readNumber(tokens, end + 1);
    // "and" only joins neighbouring verses; "John 3:16 and 4" is not a range.
    if (v2 && v2[0] > v[0] && (w !== "and" || v2[0] === v[0] + 1)) {
      verseEnd = v2[0];
      end += 1 + v2[1];
    }
  }
  return { verse: v[0], verseEnd, end };
}

// Reads the chapter number after a book name ("Psalm one nineteen" is Psalm 119).
function readChapter(tokens, j, book) {
  if (book.name === "Psalm") {
    const shorthand = readNumber(tokens, j, true);
    if (shorthand && shorthand[0] <= 150) return shorthand;
  }
  return readNumber(tokens, j);
}

// "Book [chapter] N [: | verse] [V [through V2]]"
function matchBookFirst(tokens, caps, i) {
  const b = matchBook(tokens, i);
  if (!b) return null;
  const { book } = b;
  let j = skipFillers(tokens, b.end);
  let marked = false; // saw "chapter", "verse", or ":"
  if (tokens[j] === "chapter") { j = skipFillers(tokens, j + 1); marked = true; }
  const ch = readChapter(tokens, j, book);
  if (!ch) return null;
  j += ch[1];

  let verse = null;
  let verseEnd = null;
  let k = skipFillers(tokens, j);
  let verseMarked = false;
  if (tokens[k] === ":" || tokens[k] === "colon") { k++; verseMarked = true; }
  if (tokens[k] === "and" && VERSE_WORDS.has(tokens[k + 1])) k++;
  if (VERSE_WORDS.has(tokens[k])) { k = skipFillers(tokens, k + 1); verseMarked = true; }
  const vs = readVerses(tokens, k);
  if (vs) {
    ({ verse, verseEnd } = vs);
    j = vs.end;
    marked ||= verseMarked;
  }

  const capitalized = caps[b.end - 1];
  const hasVerse = verse !== null || book.chapters === 1;
  if (AMBIGUOUS.has(book.name) && !marked && !(capitalized && hasVerse)) return null;
  return build(book, ch[0], verse, verseEnd, i, j);
}

// "chapter N of [the book of] Book [verse V]"
function matchChapterFirst(tokens, i) {
  if (tokens[i] !== "chapter") return null;
  const ch = readNumber(tokens, i + 1);
  if (!ch || tokens[i + 1 + ch[1]] !== "of") return null;
  const b = matchBook(tokens, skipBookOf(tokens, i + 2 + ch[1]));
  if (!b) return null;
  let j = b.end;
  let verse = null;
  let verseEnd = null;
  let k = tokens[j] === "and" ? j + 1 : j;
  if (VERSE_WORDS.has(tokens[k])) {
    const vs = readVerses(tokens, skipFillers(tokens, k + 1));
    if (vs) ({ verse, verseEnd, end: j } = vs);
  }
  return build(b.book, ch[0], verse, verseEnd, i, j);
}

// "verse V [through V2] of [the book of] Book [chapter] N"
function matchVerseFirst(tokens, i) {
  if (!VERSE_WORDS.has(tokens[i])) return null;
  const vs = readVerses(tokens, i + 1);
  if (!vs || tokens[vs.end] !== "of") return null;
  const b = matchBook(tokens, skipBookOf(tokens, vs.end + 1));
  if (!b) return null;
  let j = b.end;
  if (tokens[j] === "chapter") j++;
  const ch = readChapter(tokens, j, b.book);
  if (!ch) return null;
  return build(b.book, ch[0], vs.verse, vs.verseEnd, i, j + ch[1]);
}

// Validates a parsed reference and returns { ref, start, end } or null.
function build(book, chapter, verse, verseEnd, start, end) {
  // In a one-chapter book a lone number is the verse ("Jude 3").
  if (book.chapters === 1 && verse === null) {
    verse = chapter;
    chapter = 1;
  }
  if (chapter < 1 || chapter > book.chapters) return null;
  const max = verseCounts?.[book.name]?.[chapter - 1] ?? 176;
  if (verse !== null && (verse < 1 || verse > max)) {
    if (book.chapters === 1) return null;
    verse = verseEnd = null; // misheard verse: still show the chapter
  }
  if (verseEnd !== null && verseEnd > max) verseEnd = max;

  let ref = book.chapters === 1 ? book.name : `${book.name} ${chapter}`;
  if (verse !== null) ref += book.chapters === 1 ? ` ${verse}` : `:${verse}`;
  if (verseEnd !== null && verseEnd > verse) ref += `-${verseEnd}`;
  return {
    ref: { ref, url: nkjvUrl(ref), book: book.name, chapter, verse, verseEnd: verseEnd > verse ? verseEnd : null },
    start,
    end,
  };
}

function matchAt(tokens, caps, i) {
  return matchChapterFirst(tokens, i) || matchVerseFirst(tokens, i) || matchBookFirst(tokens, caps, i);
}

// Every reference in a token list, left to right, as { ref, start, end } token spans.
function scan(tokens, caps) {
  const found = [];
  for (let i = 0; i < tokens.length; ) {
    const m = matchAt(tokens, caps, i);
    if (m) {
      found.push(m);
      i = m.end;
    } else {
      i++;
    }
  }
  return found;
}

// Returns [{ ref: "John 3:16", url, book, chapter, verse, verseEnd }] for each
// reference found in text. verse/verseEnd are null when not spoken.
function findVerseRefs(text) {
  const { tokens, caps } = tokenize(text);
  return scan(tokens, caps).map((m) => m.ref);
}

// Follows the transcript line by line. Keeps the last few words of recent lines so
// references split across lines are found, and reports each reference once. When a
// reference grows ("Genesis 3" then "16" on the next line) it is reported again with
// `replaces` set to the shorter one.
class VerseTracker {
  static KEEP_TOKENS = 30; // longer than any spoken reference
  static MAX_GAP = 4; // seconds of silence after which lines are not joined

  constructor() {
    this.reset();
  }

  reset() {
    this.tokens = [];
    this.caps = [];
    this.base = 0; // absolute index of tokens[0]
    this.lastEnd = null;
    this.reported = new Map(); // absolute start token -> ref string
  }

  // Adds a finished line; returns newly found refs, each with `replaces` (or null).
  // start/duration are the line's position in seconds, used to avoid joining lines
  // separated by a long pause.
  addFinal(text, start = null, duration = 0) {
    if (start !== null && this.lastEnd !== null && start - this.lastEnd > VerseTracker.MAX_GAP) {
      this.base += this.tokens.length;
      this.tokens = [];
      this.caps = [];
      this.reported.clear();
    }
    if (start !== null) this.lastEnd = start + duration;

    const oldLength = this.tokens.length;
    const line = tokenize(text);
    this.tokens.push(...line.tokens);
    this.caps.push(...line.caps);

    const results = [];
    for (const m of scan(this.tokens, this.caps)) {
      if (m.end <= oldLength) continue; // entirely in earlier lines, already handled
      const abs = this.base + m.start;
      const previous = this.reported.get(abs);
      if (previous === m.ref.ref) continue;
      this.reported.set(abs, m.ref.ref);
      results.push({ ...m.ref, replaces: previous ?? null });
    }

    const cut = this.tokens.length - VerseTracker.KEEP_TOKENS;
    if (cut > 0) {
      this.tokens.splice(0, cut);
      this.caps.splice(0, cut);
      this.base += cut;
      for (const abs of this.reported.keys()) if (abs < this.base) this.reported.delete(abs);
    }
    return results;
  }

  // Refs in a line still being spoken, joined to the recent tail. Doesn't change state.
  // Partial text revises its trailing words ("13:3" becomes "13:4-7"), so only refs
  // with a verse and at least one word after them count as settled.
  peek(text) {
    const line = tokenize(text);
    const tokens = [...this.tokens, ...line.tokens];
    const caps = [...this.caps, ...line.caps];
    return scan(tokens, caps)
      .filter((m) => m.end > this.tokens.length && m.end < tokens.length && m.ref.verse !== null)
      .map((m) => m.ref);
  }
}

function nkjvUrl(ref) {
  return `https://www.biblegateway.com/passage/?search=${encodeURIComponent(ref)}&version=NKJV`;
}

if (typeof module !== "undefined") module.exports = { findVerseRefs, VerseTracker, setVerseCounts };
