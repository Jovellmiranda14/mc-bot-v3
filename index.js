require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logging.js');

const app = express();
const BOTS_FILE = path.join(__dirname, 'bots.json');

let activeBots = [];
let logs = [];

app.use(express.json());

function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.push(entry);
  if (logs.length > 25) logs.shift();
  console.log(entry);
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
  addLog(`Connecting ${botConfig.username} to ${botConfig.host}:${botConfig.port}...`);

  const bot = mineflayer.createBot({
    host: botConfig.host,
    port: parseInt(botConfig.port),
    username: botConfig.username,
    password: botConfig.password,
    auth: botConfig.type,
    version: process.env.SERVER_VERSION || false,
    connectTimeout: 60000, // Wait 60s for Aternos to respond
    keepAlive: true,       // Prevents random "socket closed"
    hideErrors: false      // Shows us exactly why it fails
  });

  bot.once('spawn', () => {
    addLog(`SUCCESS: ${bot.username} spawned!`);
  });

  // Capture Chat
  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString();
    // Optional: filter out spammy messages here
    addLog(`[CHAT] ${bot.username}: ${message.substring(0, 50)}...`);
  });

  bot.on('error', (err) => addLog(`ERROR: ${botConfig.username} - ${err.message}`));

  bot.on('end', (reason) => {
    addLog(`OFFLINE: ${botConfig.username} (${reason})`);
    const state = activeBots.find(b => b.index === index);
    if (state) {
      state.instance = null;
      if (!state.manuallyStopped && process.env.AUTO_RECONNECT === 'true') {
        addLog(`Reconnecting ${botConfig.username} in 5s...`);
        setTimeout(() => startBot(index), 5000);
      }
    }
  });

  return bot;
}

function startBot(index) {
  const state = activeBots.find(b => b.index === index);
  if (state && !state.instance) {
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

// --- API ---
app.get('/status', (req, res) => {
  res.json({
    bots: activeBots.map(b => ({
      username: b.config.username,
      host: b.config.host,
      status: b.instance ? 'online' : 'offline',
      index: b.index
    })),
    logs
  });
});

app.get('/inventory/:index', (req, res) => {
  // Find bot by index
  const botState = activeBots.find(b => b.index == req.params.index);
  const bot = botState?.instance;

  if (!bot || !bot.inventory) return res.json({ items: [] });

  const items = bot.inventory.items().map(i => ({
    name: i.displayName,
    count: i.count
  }));
  res.json({ items });
});

app.post('/add-bot', (req, res) => {
  const { host, port, username, password, type } = req.body;
  const config = {
    host: host || process.env.SERVER_IP,
    port: port || process.env.SERVER_PORT || 25565,
    username, password: password || '', type: type || 'offline'
  };

  const index = Date.now() + Math.random();
  activeBots.push({ config, instance: null, index, manuallyStopped: false });
  saveAllBots();
  startBot(index);
  res.json({ success: true });
});

app.post('/control', (req, res) => {
  const { command, index } = req.body;
  command === 'start' ? startBot(index) : stopBot(index);
  res.json({ success: true });
});

app.post('/delete-bot', (req, res) => {
  const { index } = req.body;
  stopBot(index);
  activeBots = activeBots.filter(b => b.index !== index);
  saveAllBots();
  res.json({ success: true });
});

// --- UI ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Bot Hub Pro</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white p-4 font-sans">
        <div class="max-w-6xl mx-auto grid lg:grid-cols-4 gap-6">
            
            <div class="lg:col-span-1 space-y-4">
                <div class="bg-slate-800 p-4 rounded-xl border border-slate-700">
                    <h2 class="font-bold text-blue-400 mb-4 uppercase text-sm">Deploy Bot</h2>
                    <input id="h" placeholder="Server IP" class="w-full bg-slate-900 p-2 mb-2 rounded border border-slate-700 text-sm">
                    <input id="po" placeholder="Port" class="w-full bg-slate-900 p-2 mb-2 rounded border border-slate-700 text-sm">
                    <input id="u" placeholder="Username" class="w-full bg-slate-900 p-2 mb-2 rounded border border-slate-700 text-sm">
                    <select id="t" class="w-full bg-slate-900 p-2 mb-4 rounded border border-slate-700 text-sm">
                        <option value="offline">Offline/Cracked</option>
                        <option value="microsoft">Microsoft/Premium</option>
                    </select>
                    <button onclick="addBot()" class="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded font-bold transition">Launch</button>
                </div>
                <div class="bg-black p-4 rounded-xl h-96 overflow-y-auto text-[10px] font-mono text-green-500 border border-slate-700" id="logs"></div>
            </div>

            <div class="lg:col-span-3 grid md:grid-cols-2 gap-4" id="bot-list"></div>
        </div>

        <div id="inv-modal" class="hidden fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
            <div class="bg-slate-800 p-6 rounded-2xl max-w-md w-full border border-blue-500 shadow-2xl">
                <h2 id="inv-name" class="text-xl font-bold mb-4 text-blue-400">Inventory</h2>
                <div id="inv-grid" class="grid grid-cols-3 gap-2 mb-6 max-h-64 overflow-y-auto"></div>
                <button onclick="document.getElementById('inv-modal').classList.add('hidden')" class="w-full bg-slate-700 py-2 rounded hover:bg-slate-600 transition">Close</button>
            </div>
        </div>

        <script>
            async function updateUI() {
                const res = await fetch('/status');
                const data = await res.json();
                
                const logDiv = document.getElementById('logs');
                logDiv.innerHTML = data.logs.map(l => \`<div>\${l}</div>\`).join('');
                logDiv.scrollTop = logDiv.scrollHeight;

                document.getElementById('bot-list').innerHTML = data.bots.map(bot => \`
                    <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative">
                        <button onclick="deleteBot(\${bot.index})" class="absolute top-2 right-2 text-slate-600 hover:text-red-500 text-xs">✕</button>
                        <h3 class="font-bold text-lg">\${bot.username}</h3>
                        <p class="text-xs text-slate-400 mb-4 truncate">\${bot.host}</p>
                        <div class="flex gap-2">
                            <button onclick="openInv(\${bot.index}, '\${bot.username}')" class="flex-1 bg-slate-700 py-2 rounded text-xs hover:bg-slate-600 transition">Items</button>
                            <button onclick="controlBot('\${bot.status === 'online' ? 'stop' : 'start'}', \${bot.index})" 
                                class="flex-1 py-2 rounded text-xs font-bold transition \${bot.status === 'online' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}">
                                \${bot.status === 'online' ? 'STOP' : 'START'}
                            </button>
                        </div>
                    </div>
                \`).join('');
            }

            async function openInv(index, name) {
                const res = await fetch('/inventory/' + index);
                const data = await res.json();
                document.getElementById('inv-name').innerText = name + "'s Items";
                document.getElementById('inv-grid').innerHTML = data.items.length > 0 
                    ? data.items.map(i => \`
                        <div class="bg-slate-900 p-2 rounded text-center border border-slate-700 shadow-inner">
                            <div class="text-[10px] text-blue-300 truncate font-bold">\${i.name}</div>
                            <div class="font-bold text-lg">x\${i.count}</div>
                        </div>
                    \`).join('') 
                    : '<p class="col-span-3 text-center text-slate-500 py-4">No items found</p>';
                document.getElementById('inv-modal').classList.remove('hidden');
            }

            async function addBot() {
                const body = { 
                    host: document.getElementById('h').value, 
                    port: document.getElementById('po').value, 
                    username: document.getElementById('u').value, 
                    type: document.getElementById('t').value 
                };
                if(!body.username) return alert("Username required!");
                await fetch('/add-bot', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
                updateUI();
            }

            async function controlBot(command, index) {
                await fetch('/control', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ command, index }) });
                setTimeout(updateUI, 500);
            }

            async function deleteBot(index) {
                if(!confirm("Permanently delete this bot?")) return;
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

// --- Init ---
function init() {
  const saved = loadBots();
  // Maps the saved configs back into active status
  activeBots = saved.map(config => ({
    config,
    instance: null,
    index: Date.now() + Math.random(),
    manuallyStopped: true // Start offline by default
  }));

  addLog(`Loaded \${activeBots.length} bots from memory.`);

  // Auto-join if enabled in .env
  if (process.env.AUTO_JOIN_ENABLED === 'true') {
    activeBots.forEach((b) => startBot(b.index));
  }
}

app.listen(3000, () => {
  init();
  console.log("Dashboard: http://localhost:3000");
});