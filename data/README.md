# data

`kjv.json` is the King James Version (public domain), shaped as
`{"John": [[verse 1, verse 2, ...] per chapter], ...}` with the book names used in
`static/verses.js`. It was converted from `json/en_kjv.json` in
[thiagobodruk/bible](https://github.com/thiagobodruk/bible) (MIT) by mapping its 66
books in canonical order. It has 31,102 verses.

The NKJV is copyrighted (Thomas Nelson), so the app links to it on BibleGateway
instead of hosting its text.
