"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DATA_DIR = "data";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  const threadCount = parseInt(await ask("Số luồng: "));
  if (!threadCount || threadCount < 1) {
    console.log("Số luồng phải >= 1");
    process.exit(1);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  for (let i = 1; i <= threadCount; i++) {
    const folder = path.join(DATA_DIR, `thread${i}`);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const igFile = path.join(folder, `ig${i}.txt`);
    const metaFile = path.join(folder, `meta${i}.txt`);

    if (!fs.existsSync(igFile)) fs.writeFileSync(igFile, "");
    if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, "");

    console.log(`✅ thread${i}/ → ig${i}.txt + meta${i}.txt`);
  }

  console.log(`\n✅ Đã tạo ${threadCount} luồng trong ${DATA_DIR}/`);
  console.log("Tự bỏ data vào từng folder rồi chạy: node run.js");
  rl.close();
}

main();
