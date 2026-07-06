import fs from "node:fs";
import path from "node:path";

fs.rmSync(path.resolve(process.cwd(), "_site"), { recursive: true, force: true });
