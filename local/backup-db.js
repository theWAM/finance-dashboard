// Back up the local SQLite database to a timestamped copy in local/backups/.
// Checkpoints the WAL first so the copied .db file is fully up to date.
// The DB and backups are gitignored (private to each machine).
//
// Usage: node local/backup-db.js   (or: npm run backup)

import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

const dir = join(__dirname, "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = join(dir, `dashboard-${stamp}.db`);
copyFileSync(join(__dirname, "dashboard.db"), dest);
console.log(`Backed up database → ${dest}`);
