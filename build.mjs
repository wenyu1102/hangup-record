import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "floating.html", "floating.css", "floating.js"]) {
  cpSync(resolve(root, file), resolve(dist, file));
}
cpSync(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true });
console.log(`Built static frontend at ${dist}`);
