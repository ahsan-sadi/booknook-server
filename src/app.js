import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { getDb, dropDbClient } from "./db.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
// Covers are stored inline as JPEG data URLs, well past express.json's 100kb default.
app.use(express.json({ limit: "2mb" }));

// Browser origins allowed to read API responses. The client runs on
// http://localhost:3000 in development and on a Vercel URL in production, so
// CLIENT_URL takes a comma-separated list. Entries are normalised on the way
// in — a quoted or slash-terminated value (easy to paste in by accident) still
// matches — an empty value or "*" means "any origin", and local dev is always
// allowed so the API works before anything is configured.
const parseOrigins = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, ""))
    .filter(Boolean);

const configuredOrigins = parseOrigins(process.env.CLIENT_URL);
const allowAnyOrigin =
  configuredOrigins.length === 0 || configuredOrigins.includes("*");
const isLocalDev = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header means same-origin or a non-browser client (curl, the
      // server itself) — those are never blocked by CORS.
      if (!origin || allowAnyOrigin || isLocalDev(origin) || configuredOrigins.includes(origin))
        return callback(null, true);
      callback(null, false);
    },
  }),
);

const LOAN_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const validId = (id) => ObjectId.isValid(id);

// Express 4 does not catch rejected promises, so async handlers route their
// errors to the shared error handler instead of repeating try/catch everywhere.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const normalize = (b) => ({
  ...b,
  totalCopies: Math.max(1, Number(b.totalCopies) || 1),
  availableCopies:
    b.availableCopies == null
      ? Math.max(1, Number(b.totalCopies) || 1)
      : Math.max(0, Number(b.availableCopies) || 0),
  image: typeof b.image === "string" ? b.image : "",
});

// Both collections always come from the same cached connection.
const collections = async () => {
  const db = await getDb();
  return {
    addColl: db.collection("addbooks"),
    borrowColl: db.collection("borrows"),
  };
};

app.get("/", (req, res) => {
  res.json({ name: "booknook-api", status: "ok" });
});

// Readiness probe for uptime checks and the Vercel deployment.
app.get(
  "/health",
  wrap(async (req, res) => {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  }),
);

// Add a new book to the collection.
app.post(
  "/addbooks",
  wrap(async (req, res) => {
    const { addColl } = await collections();
    const {
      title,
      author,
      category,
      description,
      image,
      totalCopies,
      addedByName,
      addedByEmail,
    } = req.body;
    if (!title || !author || !category || !description)
      return res.status(400).json({ error: "Please fill in every field." });
    if (typeof image !== "string" || !image)
      return res.status(400).json({ error: "Please choose a cover image." });

    const copies = Math.max(1, Number(totalCopies) || 1);
    const doc = {
      title: String(title),
      author: String(author),
      category: String(category),
      description: String(description),
      image,
      totalCopies: copies,
      availableCopies: copies,
      addedByName: addedByName || "Anonymous reader",
      addedByEmail: addedByEmail || "",
      createdAt: new Date(),
    };
    const result = await addColl.insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  }),
);

// Get books from the collection. ?email= filters to one owner's shelf,
// ?limit= returns that many newest-first.
app.get(
  "/addbooks",
  wrap(async (req, res) => {
    const { addColl } = await collections();
    const { email, limit } = req.query;
    const filter = email ? { addedByEmail: email } : {};
    const cursor = addColl.find(filter).sort({ createdAt: -1 });
    if (Number(limit) > 0) cursor.limit(Number(limit));
    const books = await cursor.toArray();
    res.json(books.map(normalize));
  }),
);

app.get(
  "/addbooks/:id",
  wrap(async (req, res) => {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Book not found." });
    const { addColl } = await collections();
    const book = await addColl.findOne({ _id: new ObjectId(req.params.id) });
    if (!book) return res.status(404).json({ error: "Book not found." });
    res.json(normalize(book));
  }),
);

// Update book details; lowering totalCopies keeps loaned copies accounted for.
app.patch(
  "/addbooks/:id",
  wrap(async (req, res) => {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That book link is not valid." });
    const { addColl } = await collections();
    const _id = new ObjectId(req.params.id);
    const existing = await addColl.findOne({ _id });
    if (!existing) return res.status(404).json({ error: "Book not found." });

    const { title, author, category, description, image, totalCopies } =
      req.body;
    const update = {};
    if (title !== undefined) update.title = String(title);
    if (author !== undefined) update.author = String(author);
    if (category !== undefined) update.category = String(category);
    if (description !== undefined) update.description = String(description);
    if (image !== undefined) {
      if (typeof image !== "string" || !image)
        return res.status(400).json({ error: "Please choose a cover image." });
      update.image = image;
    }
    if (totalCopies !== undefined) {
      const total = Math.max(1, Number(totalCopies) || 1);
      const storedTotal = Number(existing.totalCopies) || total;
      const storedAvailable =
        existing.availableCopies == null
          ? storedTotal
          : Number(existing.availableCopies) || 0;
      const loaned = Math.max(0, storedTotal - storedAvailable);
      update.totalCopies = total;
      update.availableCopies = Math.max(0, total - loaned);
    }
    if (!Object.keys(update).length)
      return res.status(400).json({ error: "Nothing to update." });

    update.updatedAt = new Date();
    await addColl.updateOne({ _id }, { $set: update });
    res.json({ message: "Book updated." });
  }),
);

// Delete a book from the collection.
app.delete(
  "/addbooks/:id",
  wrap(async (req, res) => {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That book link is not valid." });
    const { addColl } = await collections();
    const result = await addColl.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount)
      return res.status(404).json({ error: "Book not found." });
    res.json({ message: "Book deleted." });
  }),
);

// ---------------------------------------------------------------------------
// Borrows — the reader's email identifies the loan, same style as /addbooks.
// ---------------------------------------------------------------------------

// Loans for one reader, newest first.
app.get(
  "/borrows",
  wrap(async (req, res) => {
    const { email } = req.query;
    if (!email)
      return res.status(400).json({ error: "Tell us whose loans to show." });
    const { borrowColl } = await collections();
    const borrows = await borrowColl
      .find({ userEmail: String(email) })
      .sort({ borrowDate: -1 })
      .toArray();
    res.json(borrows);
  }),
);

// Borrow a book: take a copy off the shelf, then record the 7-day loan.
app.post(
  "/borrows",
  wrap(async (req, res) => {
    const { bookId, userEmail, userName } = req.body;
    if (!validId(bookId))
      return res.status(400).json({ error: "That book link is not valid." });
    if (!userEmail)
      return res.status(400).json({ error: "Sign in to borrow a book." });

    const { addColl, borrowColl } = await collections();
    const _id = new ObjectId(bookId);
    const book = await addColl.findOne({ _id });
    if (!book)
      return res.status(404).json({ error: "We couldn't find that book." });

    // Atomic: only decrement while a copy is actually free.
    const dec = await addColl.updateOne(
      { _id, availableCopies: { $gt: 0 } },
      { $inc: { availableCopies: -1 } },
    );
    if (!dec.modifiedCount)
      return res
        .status(409)
        .json({ error: "Every copy is out on loan right now." });

    const now = new Date();
    const loan = {
      bookId: String(book._id),
      bookTitle: book.title,
      bookAuthor: book.author,
      bookImage: typeof book.image === "string" ? book.image : "",
      userEmail: String(userEmail),
      userName: userName || "Reader",
      borrowDate: now,
      returnDate: new Date(now.getTime() + LOAN_DAYS * DAY),
    };

    try {
      const result = await borrowColl.insertOne(loan);
      res.status(201).json({ ...loan, _id: result.insertedId });
    } catch (err) {
      // Unique index: this reader already holds the book — put the copy back.
      await addColl.updateOne({ _id }, { $inc: { availableCopies: 1 } });
      if (err?.code === 11000)
        return res.status(409).json({
          error: "You already have this book. Return it before borrowing again.",
        });
      throw err;
    }
  }),
);

// Return a book: drop the loan and put the copy back on the shelf.
app.delete(
  "/borrows/:id",
  wrap(async (req, res) => {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That loan is not valid." });
    const { addColl, borrowColl } = await collections();
    const loan = await borrowColl.findOneAndDelete({
      _id: new ObjectId(req.params.id),
    });
    if (!loan)
      return res.status(404).json({ error: "We couldn't find that loan." });
    if (validId(loan.bookId))
      await addColl.updateOne(
        { _id: new ObjectId(loan.bookId) },
        { $inc: { availableCopies: 1 } },
      );
    res.json({ message: "Book returned." });
  }),
);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Shared error handler: never leak stack traces to the client.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large")
    return res.status(413).json({ error: "Cover image is too large." });
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "Request body is not valid JSON." });
  if (err.name?.startsWith("Mongo")) dropDbClient();
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

export default app;
