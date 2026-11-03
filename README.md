# BookNook API

Express + MongoDB server for BookNook (collections `addbooks` + `borrows` in the
`booknook` DB). The Next.js client calls it through `lib/shelf-api.js` on
**http://localhost:5000**.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | /addbooks | List newest-first; `?email=` filters to one owner, `?limit=` caps the count |
| POST | /addbooks | Create a book (validates title/author/category/description/cover) |
| GET | /addbooks/:id | One book |
| PATCH | /addbooks/:id | Update; lowering `totalCopies` keeps borrowed copies accounted for |
| DELETE | /addbooks/:id | Delete a book |
| GET | /borrows | One reader's loans, newest first — requires `?email=` |
| POST | /borrows | Borrow: body `{ bookId, userEmail, userName }` |
| DELETE | /borrows/:id | Return the loan |

There is no auth middleware: readers are identified by the `?email=` query param
(the same open style the original `/addbooks` routes used).

## Highlights

- `$inc` on `availableCopies` for borrow (-1) and return (+1), gated on `>0`
- Unique index on `(bookId, userEmail)` blocks double borrows; a rejected insert
  rolls the decremented copy back
- 7-day loans: each borrow stores `borrowDate`, `returnDate` and a denormalised
  title/author/cover snapshot for the reader's list
- Covers are stored inline as JPEG data URLs, so `express.json` allows 2mb

## Run

```bash
cp .env.example .env   # PORT, MONGODB_URI, DB_NAME, CLIENT_URL
npm install
node seed.mjs          # one-off: load the demo catalogue, drop smoke-test docs
npm start              # nodemon, port 5000 (npm run dev = node --watch)
```
# booknook-server
