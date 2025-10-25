// server.js
import express from "express";
import next from "next";
import path from "path";
import { fileURLToPath } from "url";

// Initialize Next.js
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// Import your backend Express app
import backend from "./ai-backend/index.js"; // 👈 this is your backend entry

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.prepare().then(() => {
  const server = express();

  // Mount backend under /api
  server.use("/api", backend);

  // Let Next.js handle all other routes
  server.all("*", (req, res) => handle(req, res));

  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`✅ Unified app ready at http://localhost:${PORT}`);
  });
});
