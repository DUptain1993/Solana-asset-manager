import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "campaigns.json");
const TMP = FILE + ".tmp";

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadAll() {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveAll(map) {
  ensureDir();
  fs.writeFileSync(TMP, JSON.stringify(map, null, 2));
  fs.renameSync(TMP, FILE);
}

export function put(id, record) {
  const all = loadAll();
  all[id] = { ...(all[id] || {}), ...record };
  saveAll(all);
  return all[id];
}

export function get(id) {
  return loadAll()[id] || null;
}

export function list() {
  return Object.entries(loadAll()).map(([id, r]) => ({ id, ...r }));
}

export function remove(id) {
  const all = loadAll();
  delete all[id];
  saveAll(all);
}

export function update(id, patch) {
  const all = loadAll();
  if (!all[id]) return null;
  all[id] = { ...all[id], ...patch };
  saveAll(all);
  return all[id];
}
