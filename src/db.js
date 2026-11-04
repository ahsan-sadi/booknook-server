import { MongoClient } from "mongodb";

// Cache the client on globalThis: a warm serverless invocation reuses the same
// module scope, so we keep one connection pool alive instead of opening a new
// one per request (or per cold start retry).
const state = (globalThis.__booknookDb ??= { client: null });

let indexesEnsured = false;

const dbName = () => process.env.DB_NAME || "booknook";

/** Opens (or reuses) the connection and hands back the database. */
export async function getDb() {
  if (!state.client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured.");

    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    try {
      await client.connect();
    } catch (err) {
      // Leave the cache empty so the next request attempts a fresh connect.
      throw err;
    }
    state.client = client;
  }

  if (!indexesEnsured) {
    indexesEnsured = true;
    // One active loan per reader per book; non-fatal if it cannot be built.
    state.client
      .db(dbName())
      .collection("borrows")
      .createIndex({ bookId: 1, userEmail: 1 }, { unique: true })
      .catch((err) => console.error("Could not ensure unique index:", err.message));
  }

  return state.client.db(dbName());
}

/** Drops the cached client after a connection error so the next request reconnects. */
export function dropDbClient() {
  const client = state.client;
  state.client = null;
  client?.close().catch(() => {});
}
