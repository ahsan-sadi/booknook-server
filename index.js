import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
const app = express();
const PORT = process.env.PORT || 5000;

// Covers are stored inline as JPEG data URLs, well past express.json's 100kb default.
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
let dbClient = await connectToMongoDB();

const myDB = dbClient.db("booknook");
const addColl = myDB.collection("addbooks");
const borrowColl = myDB.collection("borrows");

const LOAN_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

// One active loan per reader per book; returning deletes the loan and frees the slot.
await borrowColl.createIndex({ bookId: 1, userEmail: 1 }, { unique: true });

app.get("/", (req, res) => {
  res.send("Hello, World!");
});

const validId = (id) => ObjectId.isValid(id);

const normalize = (b) => ({
  ...b,
  totalCopies: Math.max(1, Number(b.totalCopies) || 1),
  availableCopies:
    b.availableCopies == null
      ? Math.max(1, Number(b.totalCopies) || 1)
      : Math.max(0, Number(b.availableCopies) || 0),
  image: typeof b.image === "string" ? b.image : "",
});

// Add a new book to the collection

app.post("/addbooks", async (req, res) => {
  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get books from the collection. ?email= filters to one owner's shelf,
// ?limit= returns that many newest-first.
app.get("/addbooks", async (req, res) => {
  try {
    const { email, limit } = req.query;
    const filter = email ? { addedByEmail: email } : {};
    const cursor = addColl.find(filter).sort({ createdAt: -1 });
    if (Number(limit) > 0) cursor.limit(Number(limit));
    const books = await cursor.toArray();
    res.status(200).json(books.map(normalize));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/addbooks/:id", async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Book not found." });
    const book = await addColl.findOne({ _id: new ObjectId(req.params.id) });
    if (!book) {
      return res.status(404).json({ error: "Book not found." });
    }
    res.status(200).json(normalize(book));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update Book Details
app.patch("/addbooks/:id", async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That book link is not valid." });
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Delete a book from the collection
app.delete("/addbooks/:id", async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That book link is not valid." });
    const _id = new ObjectId(req.params.id);
    const result = await addColl.deleteOne({ _id });
    if (!result.deletedCount)
      return res.status(404).json({ error: "Book not found." });
    res.json({ message: "Book deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------------------------------------------------------------------
// Borrows — the reader's email identifies the loan, same style as /addbooks.
// ---------------------------------------------------------------------------

// Loans for one reader, newest first.
app.get("/borrows", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email)
      return res.status(400).json({ error: "Tell us whose loans to show." });
    const borrows = await borrowColl
      .find({ userEmail: String(email) })
      .sort({ borrowDate: -1 })
      .toArray();
    res.status(200).json(borrows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Borrow a book: take a copy off the shelf, then record the 7-day loan.
app.post("/borrows", async (req, res) => {
  try {
    const { bookId, userEmail, userName } = req.body;
    if (!validId(bookId))
      return res.status(400).json({ error: "That book link is not valid." });
    if (!userEmail)
      return res.status(400).json({ error: "Sign in to borrow a book." });

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
          error:
            "You already have this book. Return it before borrowing again.",
        });
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Return a book: drop the loan and put the copy back on the shelf.
app.delete("/borrows/:id", async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "That loan is not valid." });
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
