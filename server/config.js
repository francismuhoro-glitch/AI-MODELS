'use strict';
const fs = require('fs');
const path = require('path');

const IS_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, '..', 'data');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  owner: { name: 'Francis Muhoro', timezone: 'Africa/Nairobi', location: { label: 'Nairobi, Kenya' } },
  rhythm: { wakeHour: 6, workStartHour: 8, workEndHour: 17, sleepHour: 22 },
  ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.1' },
  telegram: { enabled: false, token: '', allowedChatId: '' }
};

let memCfg = null;

function load() {
  if (memCfg) return memCfg;
  try {
    if (fs.existsSync(CFG_FILE)) {
      memCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    }
  } catch (_) {}
  if (!memCfg) memCfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  memCfg.owner = memCfg.owner || DEFAULT_CONFIG.owner;
  return memCfg;
}

async function save(patch) {
  const cfg = load();
  if (patch.owner) cfg.owner = { ...cfg.owner, ...patch.owner };
  if (patch.rhythm) cfg.rhythm = { ...cfg.rhythm, ...patch.rhythm };
  if (patch.ollama) cfg.ollama = { ...cfg.ollama, ...patch.ollama };
  if (patch.telegram) cfg.telegram = { ...cfg.telegram, ...patch.telegram };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) {}
  return cfg;
}

module.exports = { load, save };
