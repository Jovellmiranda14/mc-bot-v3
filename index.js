require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
const BOTS_FILE = path.join(__dirname, 'bots.json');

let activeBots = [];
let logs = [];

app.use(express.json());

// --- Utilities ---
function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.push(entry);
  if (logs.length > 50) logs.shift();
  console.log(entry);
}

/**
 * Checks if the Minecraft server port is actually open/reachable
 */
function checkServerAlive(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// --- Persistence ---
function loadBots() {
  if (!fs.existsSync(BOTS_FILE)) return [];
  try {
    const data = fs.readFileSync(BOTS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    addLog("Error reading bots.json");
    return [];
  }
}

function saveAllBots() {
  const configs = activeBots.map(b => b.config);
  fs.writeFileSync(BOTS_FILE, JSON.stringify(configs, null, 2));
}

// --- Bot Management ---
function createBotInstance(botConfig, index) {
  addLog(`Initiating handshake for ${botConfig.username}...`);

  const bot = mineflayer.createBot({
    host: botConfig.host,
    port: parseInt(botConfig.port),
    username: botConfig.username,
    password: botConfig.password,
    auth: botConfig.type,
    version: process.env.SERVER_VERSION || false,
    connectTimeout: 60000, // Vital for Aternos
    keepAlive: true
  });

  bot.once('spawn', () => {
    addLog(`SUCCESS: ${bot.username} joined the game.`);
  });

  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString();
    if (message.trim().length > 0) {
      addLog(`[CHAT] ${bot.username}: ${message.substring(0, 60)}`);
    }
  });

  bot.on('error', (err) => {
    addLog(`ERROR: ${botConfig.username} - ${err.message}`);
  });

  bot.on('end', (reason) => {
    addLog(`OFFLINE: ${botConfig.username} (${reason})`);
    const state = activeBots.find(b => b.index === index);
    if (state) {
      state.instance = null;
      if (!state.manuallyStopped && process.env.AUTO_RECONNECT === 'true') {
        addLog(`Auto-reconnecting ${botConfig.username} in 10s...`);
        setTimeout(() => startBot(index), 10000);
      }
    }
  });

  return bot;
}

async function startBot(index) {
  const state = activeBots.find(b => b.index === index);
  if (state && !state.instance) {
    addLog(`Pinging ${state.config.host}:${state.config.port}...`);

    const isAlive = await checkServerAlive(state.config.host, state.config.port);

    if (!isAlive) {
      addLog(`ABORT: Server ${state.config.host} is unreachable. Check Aternos Status.`);
      return;
    }

    state.instance = createBotInstance(state.config, index);
    state.manuallyStopped = false;
  }
}

function stopBot(index) {
  const state = activeBots.find(b => b.index === index);
  if (state && state.instance) {
    state.manuallyStopped = true;
    state.instance.quit();
    state.instance = null;
  }
}

// --- API Routes ---
app.get('/status', (req, res) => {
  res.json({
    bots: activeBots.map(b => ({
      username: b.config.username,
      host: b.config.host,
      port: b.config.port,
      status: b.instance ? 'online' : 'offline',
      index: b.index
    })),
    logs
  });
});

app.get('/inventory/:index', (req, res) => {
  const botState = activeBots.find(b => b.index == req.params.index);
  const bot = botState?.instance;
  if (!bot || !bot.inventory) return res.json({ items: [] });
  const items = bot.inventory.items().map(i => ({ name: i.displayName, count: i.count }));
  res.json({ items });
});

app.post('/add-bot', async (req, res) => {
  const { host, port, username, password, type } = req.body;
  const config = {
    host: host || process.env.SERVER_IP,
    port: port || process.env.SERVER_PORT || 25565,
    username, password: password || '', type: type || 'offline'
  };
  const index = Date.now() + Math.random();
  activeBots.push({ config, instance: null, index, manuallyStopped: false });
  saveAllBots();
  await startBot(index);
  res.json({ success: true });
});

app.post('/control', async (req, res) => {
  const { command, index } = req.body;
  command === 'start' ? await startBot(index) : stopBot(index);
  res.json({ success: true });
});

app.post('/delete-bot', (req, res) => {
  const { index } = req.body;
  stopBot(index);
  activeBots = activeBots.filter(b => b.index !== index);
  saveAllBots();
  res.json({ success: true });
});

// --- UI Rendering ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Minecraft Bot Commander</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            ::-webkit-scrollbar { width: 6px; }
            ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            .log-entry { border-left: 2px solid #3b82f6; padding-left: 8px; margin-bottom: 4px; }
        </style>
    </head>
    <body class="bg-slate-950 text-slate-200 min-h-screen p-4 font-sans">
        <div class="max-w-7xl mx-auto grid lg:grid-cols-4 gap-6">
            
            <div class="lg:col-span-1 space-y-4">
                <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl">
                    <h2 class="text-blue-400 font-black uppercase tracking-widest text-xs mb-4">Deploy New Unit</h2>
                    <div class="space-y-3">
                        <input id="h" placeholder="Server IP (e.g. host.aternos.me)" class="w-full bg-slate-800 p-3 rounded-lg border border-slate-700 focus:border-blue-500 outline-none transition text-sm">
                        <input id="po" placeholder="Port (Default 25565)" class="w-full bg-slate-800 p-3 rounded-lg border border-slate-700 focus:border-blue-500 outline-none transition text-sm">
                        <input id="u" placeholder="Bot Username" class="w-full bg-slate-800 p-3 rounded-lg border border-slate-700 focus:border-blue-500 outline-none transition text-sm">
                        <select id="t" class="w-full bg-slate-800 p-3 rounded-lg border border-slate-700 text-sm outline-none">
                            <option value="offline">Offline / Cracked</option>
                            <option value="microsoft">Microsoft (Premium)</option>
                        </select>
                        <button onclick="addBot()" class="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-bold shadow-lg shadow-blue-900/20 transition-all active:scale-95">Launch Instance</button>
                    </div>
                </div>

                <div class="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden shadow-xl">
                    <div class="bg-slate-800/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                        <span class="text-[10px] font-bold uppercase text-slate-400">System Logs</span>
                        <span class="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                    </div>
                    <div id="logs" class="h-80 overflow-y-auto p-4 text-[11px] font-mono text-slate-400 space-y-1"></div>
                </div>
            </div>

            <div class="lg:col-span-3">
                <div id="bot-list" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                    </div>
            </div>
        </div>

        <div id="inv-modal" class="hidden fixed inset-0 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div class="bg-slate-900 p-8 rounded-3xl max-w-lg w-full border border-slate-800 shadow-2xl">
                <div class="flex justify-between items-center mb-6">
                    <h2 id="inv-name" class="text-2xl font-black text-white">Inventory</h2>
                    <button onclick="closeInv()" class="text-slate-500 hover:text-white transition">✕</button>
                </div>
                <div id="inv-grid" class="grid grid-cols-4 gap-3 max-h-96 overflow-y-auto pr-2"></div>
            </div>
        </div>

        <script>
            async function updateUI() {
                try {
                    const res = await fetch('/status');
                    const data = await res.json();
                    
                    const logDiv = document.getElementById('logs');
                    logDiv.innerHTML = data.logs.map(l => \`<div class="log-entry">\${l}</div>\`).join('');
                    logDiv.scrollTop = logDiv.scrollHeight;

                    document.getElementById('bot-list').innerHTML = data.bots.map(bot => \`
                        <div class="bg-slate-900 p-6 rounded-2xl border \${bot.status === 'online' ? 'border-blue-500/30' : 'border-slate-800'} shadow-xl relative group transition-all hover:border-blue-500/50">
                            <button onclick="deleteBot(\${bot.index})" class="absolute top-4 right-4 text-slate-600 hover:text-red-500 transition">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                                </svg>
                            </button>
                            
                            <div class="flex items-center gap-3 mb-4">
                                <div class="w-12 h-12 bg-slate-800 rounded-xl flex items-center justify-center font-bold text-blue-400 border border-slate-700">
                                    \${bot.username.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <h3 class="font-black text-lg text-white">\${bot.username}</h3>
                                    <div class="flex items-center gap-1.5">
                                        <span class="h-2 w-2 rounded-full \${bot.status === 'online' ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}"></span>
                                        <span class="text-[10px] uppercase font-bold tracking-tight \${bot.status === 'online' ? 'text-green-500' : 'text-slate-500'}">\${bot.status}</span>
                                    </div>
                                </div>
                            </div>

                            <p class="text-xs text-slate-500 mb-6 font-mono truncate bg-slate-950 p-2 rounded-lg">\${bot.host}:\${bot.port}</p>
                            
                            <div class="flex gap-2">
                                <button onclick="openInv(\${bot.index}, '\${bot.username}')" class="flex-1 bg-slate-800 hover:bg-slate-700 py-2.5 rounded-xl text-xs font-bold transition">Inventory</button>
                                <button onclick="controlBot('\${bot.status === 'online' ? 'stop' : 'start'}', \${bot.index})" 
                                    class="flex-[2] py-2.5 rounded-xl text-xs font-black transition-all \${bot.status === 'online' ? 'bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-900/40'}">
                                    \${bot.status === 'online' ? 'TERMINATE' : 'INITIALIZE'}
                                </button>
                            </div>
                        </div>
                    \`).join('');
                } catch(e) { console.error("UI Update Sync Error"); }
            }

            function closeInv() { document.getElementById('inv-modal').classList.add('hidden'); }

            async function openInv(index, name) {
                const res = await fetch('/inventory/' + index);
                const data = await res.json();
                document.getElementById('inv-name').innerText = name;
                document.getElementById('inv-grid').innerHTML = data.items.length > 0 
                    ? data.items.map(i => \`
                        <div class="bg-slate-800 p-4 rounded-2xl text-center border border-slate-700 shadow-inner group hover:border-blue-500/50 transition">
                            <div class="text-[10px] text-slate-500 truncate mb-1">\${i.name}</div>
                            <div class="font-black text-xl text-white">\${i.count}</div>
                        </div>
                    \`).join('') 
                    : '<div class="col-span-4 text-center text-slate-600 py-12">No items in memory</div>';
                document.getElementById('inv-modal').classList.remove('hidden');
            }

            async function addBot() {
                const body = { 
                    host: document.getElementById('h').value, 
                    port: document.getElementById('po').value || 25565, 
                    username: document.getElementById('u').value, 
                    type: document.getElementById('t').value 
                };
                if(!body.username || !body.host) return alert("Missing Parameters");
                await fetch('/add-bot', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
                updateUI();
            }

            async function controlBot(command, index) {
                await fetch('/control', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ command, index }) });
                setTimeout(updateUI, 1000);
            }

            async function deleteBot(index) {
                if(!confirm("Destroy this instance?")) return;
                await fetch('/delete-bot', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ index }) });
                updateUI();
            }

            setInterval(updateUI, 3000);
            updateUI();
        </script>
    </body>
    </html>
    `);
});

// --- Initialization ---
function init() {
  const saved = loadBots();
  activeBots = saved.map(config => ({
    config,
    instance: null,
    index: Date.now() + Math.random(),
    manuallyStopped: true
  }));
  addLog(`System initialized. Loaded ${activeBots.length} bot profiles.`);

  if (process.env.AUTO_JOIN_ENABLED === 'true') {
    activeBots.forEach((b) => startBot(b.index));
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  init();
  console.log(`Dashboard: http://localhost:${PORT}`);
});