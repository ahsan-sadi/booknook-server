import app from "../src/app.js";

// Vercel rewrites every path to this function. Depending on the routing layer
// the request arrives as `/addbooks` or as `/api/addbooks`, so strip an `/api`
// prefix when present and let Express see the original path either way.
export default function handler(req, res) {
  const url = req.url || "/";
  if (url === "/api" || url.startsWith("/api/")) {
    req.url = url.slice(4) || "/";
  }
  return app(req, res);
}
