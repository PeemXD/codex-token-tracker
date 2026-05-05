#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, '../backend/server.js');

const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.codex-token-tracker');
const PID_FILE = path.join(CONFIG_DIR, 'ctt.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'ctt.log');
const PORT = process.env.PORT ?? 4318;

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function getPid() {
  if (fs.existsSync(PID_FILE)) {
    return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  }
  return null;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // test signal
    return true;
  } catch {
    return false;
  }
}

function start(foreground = false) {
  const currentPid = getPid();
  if (isRunning(currentPid)) {
    console.log(`[ctt] Server is already running (PID: ${currentPid})`);
    console.log(`[ctt] Access the dashboard at http://127.0.0.1:${PORT}`);
    return;
  }

  // Set DATA_DIR to global config if not set, so data persists across directories
  const env = { ...process.env, DATA_DIR: process.env.DATA_DIR || CONFIG_DIR };

  if (foreground) {
    console.log(`[ctt] Starting in foreground mode...`);
    spawn('node', [SERVER_SCRIPT], { stdio: 'inherit', env });
    return;
  }

  console.log(`[ctt] Starting proxy in background...`);
  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');

  const child = spawn('node', [SERVER_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, err],
    env
  });

  fs.writeFileSync(PID_FILE, child.pid.toString());
  child.unref();

  console.log(`[ctt] Proxy started (PID: ${child.pid})`);
  console.log(`[ctt] Logs: tail -f ${LOG_FILE}`);
  console.log(`[ctt] UI:   http://127.0.0.1:${PORT}`);
}

function stop() {
  const pid = getPid();
  if (!isRunning(pid)) {
    console.log(`[ctt] Proxy is not currently running.`);
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    return;
  }

  console.log(`[ctt] Stopping proxy (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[ctt] Stopped successfully.`);
  } catch (e) {
    console.error(`[ctt] Failed to stop process: ${e.message}`);
  }

  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

function status() {
  const pid = getPid();
  if (isRunning(pid)) {
    console.log(`[ctt] STATUS: Running`);
    console.log(`[ctt] PID:    ${pid}`);
    console.log(`[ctt] UI:     http://127.0.0.1:${PORT}`);
    console.log(`[ctt] Logs:   ${LOG_FILE}`);
  } else {
    console.log(`[ctt] STATUS: Stopped`);
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); // cleanup stale pid
  }
}

function ui() {
  const pid = getPid();
  if (!isRunning(pid)) {
    console.log(`[ctt] Proxy is not running. Starting it now...`);
    start();
  }

  const url = `http://127.0.0.1:${PORT}`;
  console.log(`[ctt] Opening ${url} ...`);

  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      execSync(`open ${url}`);
    } else if (platform === 'win32') {
      execSync(`start ${url}`);
    } else {
      execSync(`xdg-open ${url}`);
    }
  } catch (err) {
    console.error(`[ctt] Could not open browser automatically. Please open ${url} manually.`);
  }
}

function printHelp() {
  console.log(`
Codex Token Tracker CLI (ctt)

Usage: ctt <command>

Commands:
  start          Launch proxy in the background
  start --log    Run in foreground with visible logs
  stop           Shut down the proxy
  restart        Restart the proxy
  status         Check proxy health and PID
  ui             Open the web dashboard in your browser
`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'start':
    start(args.includes('--log'));
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    setTimeout(() => start(false), 1000);
    break;
  case 'status':
    status();
    break;
  case 'ui':
    ui();
    break;
  default:
    printHelp();
    break;
}
