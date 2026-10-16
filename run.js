"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DATA_DIR = "data";

function log(msg) {
  const ts = new Date().toLocaleTimeString("vi-VN");
  console.log(`[${ts}] [MAIN] ${msg}`);
}

// Parse args: node run.js 1 3 5  hoặc  node run.js (chạy all)
const args = process.argv.slice(2);
const specificThreads = args.filter((a) => /^\d+$/.test(a)).map(Number);

// Scan data/ for thread folders
let folders = fs
  .readdirSync(DATA_DIR)
  .filter((f) => fs.statSync(path.join(DATA_DIR, f)).isDirectory())
  .sort();

if (specificThreads.length > 0) {
  const wanted = new Set(specificThreads.map((n) => `thread${n}`));
  folders = folders.filter((f) => wanted.has(f));
  log(`Running specific threads: ${specificThreads.join(", ")}`);
}

if (folders.length === 0) {
  log(`No thread folders found in ${DATA_DIR}/`);
  log("Create folders like: data/thread1/ data/thread2/ ...");
  log("Each folder needs: ig.txt + meta.txt");
  process.exit(1);
}

log(`Found ${folders.length} threads to run`);

// 2K monitor: 2560x1440 → grid 2 cols x 2 rows, mỗi cửa sổ rộng thoải mái
const SCREEN_W = 2560;
const SCREEN_H = 1440;
const COLS = 2;
const WIN_W = Math.floor(SCREEN_W / COLS); // 1280
const WIN_H = Math.floor(SCREEN_H / 2); // 720

let threadIndex = 0;
const processes = [];

for (const folder of folders) {
  const dir = path.join(DATA_DIR, folder);
  // Detect file names: ig1.txt or ig.txt
  const num = folder.replace(/\D/g, "") || "";
  const igFile = fs.existsSync(path.join(dir, `ig${num}.txt`))
    ? path.join(dir, `ig${num}.txt`)
    : path.join(dir, "ig.txt");
  const metaFile = fs.existsSync(path.join(dir, `meta${num}.txt`))
    ? path.join(dir, `meta${num}.txt`)
    : path.join(dir, "meta.txt");
  const outFile = path.join(dir, `result${num}.txt`);
  const igFailFile = path.join(dir, `ig_fail${num}.txt`);
  const metaFailFile = path.join(dir, `meta_fail${num}.txt`);
  const alreadyFile = path.join(dir, `already_added${num}.txt`);

  // Grid position
  const col = threadIndex % COLS;
  const row = Math.floor(threadIndex / COLS) % 2;
  const posX = col * WIN_W;
  const posY = row * WIN_H;
  const windowSize = `${WIN_W},${WIN_H}`;
  const windowPos = `${posX},${posY}`;

  if (!fs.existsSync(igFile)) {
    log(`⚠ ${folder}: ig.txt not found, skip`);
    continue;
  }
  if (!fs.existsSync(metaFile)) {
    log(`⚠ ${folder}: meta.txt not found, skip`);
    continue;
  }

  const igCount = fs
    .readFileSync(igFile, "utf8")
    .split("\n")
    .filter(Boolean).length;
  const metaCount = fs
    .readFileSync(metaFile, "utf8")
    .split("\n")
    .filter(Boolean).length;
  log(
    `${folder}: ${igCount} IG + ${metaCount} META → pos(${posX},${posY}) size(${WIN_W}x${WIN_H})`,
  );

  const child = spawn(
    "node",
    [
      "index.js",
      igFile,
      metaFile,
      outFile,
      igFailFile,
      metaFailFile,
      windowSize,
      windowPos,
      alreadyFile,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Prefix log lines with thread name
  const prefix = `[${folder}]`;
  child.stdout.on("data", (d) => {
    String(d)
      .split("\n")
      .filter(Boolean)
      .forEach((line) => console.log(`${prefix} ${line}`));
  });
  child.stderr.on("data", (d) => {
    String(d)
      .split("\n")
      .filter(Boolean)
      .forEach((line) => console.error(`${prefix} ${line}`));
  });

  child.on("exit", (code) => {
    log(`${folder}: exited with code ${code}`);
  });

  processes.push({ folder, child });
  threadIndex++;
}

log(`${processes.length} threads running in parallel`);

// Wait for all to finish
Promise.all(
  processes.map(
    ({ folder, child }) =>
      new Promise((resolve) => {
        child.on("exit", (code) => resolve({ folder, code }));
      }),
  ),
).then((results) => {
  log("═".repeat(40));
  log("ALL THREADS DONE:");
  for (const r of results) {
    log(`  ${r.folder}: exit code ${r.code}`);
  }
});
