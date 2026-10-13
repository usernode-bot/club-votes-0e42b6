# Club Votes

A place for your club to decide things together. Anyone can post a
decision the club needs to make, everyone votes agree or disagree (one
vote per person, changeable, take it back by tapping the same choice
again), the comments under each decision run oldest first so the
conversation reads like a story, and the decision's author can close it
when the club has had its say. Closed decisions move to the **Decided**
tab with the result: agreed, not agreed, or tied, with the counts.

If someone's post or comment breaks the rules, every other person can
report it from its **More** menu. A report hides it from the reporter
straight away; once three different people have reported it, it is
hidden from everyone.

## Running locally

```sh
npm install
npm start          # serves public/ and the API on PORT (default 3000)
```

The app reads who you are from the platform-issued token the bridge
sends; there is no sign-in of our own.

## Staging demo

With `USERNODE_ENV=staging`, adding `?demo=1` to the URL seeds a set of
made-up decisions, votes and comments (flagged with a single "Staging
demo" banner, never in production) so a populated club can be seen
without real data. The demo also seeds one decision and a few
votes/comments as if the viewer had made them, so their own buttons and
"You" markers are visible.

## Data model

Five tables in the app's own Postgres database:

- `decisions` — one row per decision: author, title, body, open or
  decided (with decided counts and when), soft-delete/hidden flag,
  `is_demo` for staging demo rows.
- `votes` — one row per person per decision (unique index), `agree` or
  `disagree`; a vote is stored as an upsert, and taking a vote back
  deletes the row.
- `comments` — oldest-first thread under a decision.
- `reports` — who reported what, when. Private table (`staging:private`
  comment): reporters are never shown.
- `demo_viewers` — bookkeeping so the per-viewer staging demo seeds only
  once per person. Private table too.

Anonymous visitors can read `/api/me` and `/api/decisions*` (the club's
questions and tallies are public by design; the checks browser reads
signed out). Every write requires a signed-in account.

## Design

Look in `styles/tailwind-input.css` (colour tokens with light and dark
values, named in `tailwind.config.js`), compiled by `npm run build`.
The kit's components (`btn-primary`, `card`, `list-row`, ...) carry both
looks; the app follows the viewer's Homeroom theme via the `dark` class
the theme script sets on `<html>`.
