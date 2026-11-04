// Local entry point — Vercel serves the app through api/index.js instead.
import app from "./src/app.js";

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`BookNook API listening on http://localhost:${port}`);
});
