# BookNook API

Express + MongoDB server for BookNook (collections `addbooks` + `borrows` in the
`booknook` DB).

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Service info |
| GET | `/health` | Readiness probe — pings MongoDB |
| GET | `/addbooks` | Newest-first; `?email=` filters to one owner, `?limit=` caps the count |
| POST | `/addbooks` | Create a book (validates title/author/category/description/cover) |
| GET | `/addbooks/:id` | One book |
| PATCH | `/addbooks/:id` | Update; lowering `totalCopies` keeps borrowed copies accounted for |
| DELETE | `/addbooks/:id` | Delete a book |
| GET | `/borrows` | One reader's loans, newest first — requires `?email=` |
| POST | `/borrows` | Borrow: body `{ bookId, userEmail, userName }` |
| DELETE | `/borrows/:id` | Return the loan |

There is no auth middleware: readers are identified by the `?email=` query param.

## Layout

```
src/app.js   Express app: routes, CORS, validation, error handler
src/db.js    Cached MongoDB connection (reused across warm invocations)
api/index.js Vercel serverless entry point
index.js     Local dev server (npm start / npm run dev)
seed.mjs     One-off demo catalogue loader (npm run seed)
```

## Highlights

- `$inc` on `availableCopies` for borrow (-1) and return (+1), gated on `>0`
- Unique index on `(bookId, userEmail)` blocks double borrows; a rejected insert
  rolls the decremented copy back
- 7-day loans: each borrow stores `borrowDate`, `returnDate` and a denormalised
  title/author/cover snapshot for the reader's list
- Covers are inline JPEG data URLs, so `express.json` allows 2mb (Vercel caps
  request bodies at 4.5mb)
- CORS is restricted to the origins listed in `CLIENT_URL`

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string |
| `CLIENT_URL` | yes (prod) | Comma-separated allowed CORS origins |
| `DB_NAME` | no | Database name, defaults to `booknook` |
| `PORT` | no | Local port, defaults to `5000` |

## Run locally

```bash
cp .env.example .env   # then fill in MONGODB_URI + CLIENT_URL
npm install
npm run seed           # optional: load the demo catalogue
npm start              # http://localhost:5000  (npm run dev = watch mode)
```

## Deploy to Vercel

1. Push this repository and import it into Vercel (framework preset: **Other**).
2. In **Project Settings → Environment Variables** add `MONGODB_URI`, `CLIENT_URL`
   (your client's origin, e.g. `https://booknook.vercel.app`) and optionally `DB_NAME`.
3. Deploy. Every path is rewritten to the single Express function in `api/index.js`,
   so the client can call `https://<project>.vercel.app/addbooks` directly.
4. Smoke-test `https://<project>.vercel.app/health`.
