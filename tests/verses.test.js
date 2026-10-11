// Run with: node tests/verses.test.js
const V = require("../static/verses.js");
const kjv = require("../data/kjv.json");
V.setVerseCounts(Object.fromEntries(Object.entries(kjv).map(([b, chs]) => [b, chs.map((c) => c.length)])));
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(ok ? "ok  " : "FAIL", label, "->", JSON.stringify(got), ok ? "" : "want " + JSON.stringify(want));
};
const single = [
  ["For God so loved the world, John 3:16.", ["John 3:16"]],
  ["Turn with me to John three sixteen.", ["John 3:16"]],
  ["First Corinthians chapter thirteen verses four through seven", ["1 Corinthians 13:4-7"]],
  ["1 Corinthians 13:4-7", ["1 Corinthians 13:4-7"]],
  ["Psalm one hundred nineteen verse one oh five", ["Psalm 119:105"]],
  ["Psalm one nineteen one oh five", ["Psalm 119:105"]],
  ["Psalm a hundred and nineteen", ["Psalm 119"]],
  ["Psalm 23", ["Psalm 23"]],
  ["Psalm one three", ["Psalm 1:3"]],
  ["Romans eight twenty-eight and Romans 12:2", ["Romans 8:28", "Romans 12:2"]],
  ["Second Timothy three sixteen", ["2 Timothy 3:16"]],
  ["Jude 3", ["Jude 3"]],
  ["Song of Solomon two four", ["Song of Solomon 2:4"]],
  ["Acts chapter two", ["Acts 2"]],
  ["Mark 16:15", ["Mark 16:15"]],
  ["Revelation twenty-one four", ["Revelation 21:4"]],
  ["Philippians four thirteen", ["Philippians 4:13"]],
  ["John 3.16", ["John 3:16"]],
  ["John, uh, three sixteen", ["John 3:16"]],
  ["John chapter 3 versus 16 through 18", ["John 3:16-18"]],
  ["John 3:16 and 17", ["John 3:16-17"]],
  ["John 3 and verse 16", ["John 3:16"]],
  ["chapter 3 of Genesis verse 15", ["Genesis 3:15"]],
  ["In chapter three of the book of Romans", ["Romans 3"]],
  ["verse 16 of John chapter 3", ["John 3:16"]],
  ["verses 4 through 7 of First Corinthians 13", ["1 Corinthians 13:4-7"]],
  ["John 3:45", ["John 3"]],
  ["I love my job 5 days a week", []],
  ["numbers 1 to 10", []],
  ["mark 2 of them", []],
  ["Genesis 51", []],
  ["John", []],
];
for (const [text, want] of single) check(JSON.stringify(text), V.findVerseRefs(text).map((r) => r.ref), want);

const fmt = (rs) => rs.map((r) => (r.replaces ? `${r.ref} (replaces ${r.replaces})` : r.ref));
const lines = (pairs) => {
  const t = new V.VerseTracker();
  return pairs.map(([text, start = null, dur = 1]) => fmt(t.addFinal(text, start, dur)));
};
check("split book | ref", lines([["Let's turn to Genesis."], ["3:16 says"]]), [[], ["Genesis 3:16"]]);
check("split chapter | verse", lines([["Turn to Genesis 3", 0, 2], ["verse 16.", 2.5]]), [["Genesis 3"], ["Genesis 3:16 (replaces Genesis 3)"]]);
check("long pause not joined", lines([["Turn to Genesis", 0, 2], ["3 more things", 20]]), [[], []]);
check("no duplicates", lines([["John 3:16 is great"], ["and more words"], ["John 3:16 again"]]), [["John 3:16"], [], ["John 3:16"]]);
check("split numbered book", lines([["read First"], ["Corinthians 13 4"]]), [[], ["1 Corinthians 13:4"]]);
const t = new V.VerseTracker();
t.addFinal("open your Bibles to Romans");
check("peek partial", t.peek("eight twenty eight is").map((r) => r.ref), ["Romans 8:28"]);
check("peek chapter only hidden", t.peek("eight").map((r) => r.ref), []);
process.exit(fail ? 1 : 0);
