const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const yaml = require('js-yaml');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const { 
  client,
  ensureStarted,
  downloadDocumentViaGram,
  sendDocumentViaGram,
  sendDocumentWithRetry,
  sendDocumentAsFile,
  checkGramHealth,
  Api,
  NewMessage,
  CallbackQuery,
  Button
} = require('./gram');

const bot = new TelegramBot(config.TokenBot, {
  polling: true,
  baseApiUrl: config.ApiTg,
});

let lastPollingErrorLog = 0;
bot.on('polling_error', (err) => {
  const now = Date.now();
  if (now - lastPollingErrorLog > 10000) {
    lastPollingErrorLog = now;
    console.error(`[POLLING ERROR] ${err.code || ''}: ${err.message}. Bot otomatis retry polling...`);
  }
});

if (!fs.existsSync(config.DirFile)) {
  fs.mkdirSync(config.DirFile, { recursive: true });
  console.log(`✅ Created temp directory: ${config.DirFile}`);
}

if (!fs.existsSync(config.BACKUP_DIR)) {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  console.log(`✅ Created backup directory: ${config.BACKUP_DIR}`);
}

function tmpPath(filename) {
  return path.join(config.DirFile, filename);
}

ensureStarted().catch((err) => console.error('Gagal start GramJS:', err.message));

function cleanupStaleTempFiles() {
  try {
    const tmpRoot = config.DirFile;
    
    if (!fs.existsSync(tmpRoot)) {
      return;
    }
    
    const oneHourMs = 60 * 60 * 1000;
    let cleaned = 0;
    let freedBytes = 0;

    for (const name of fs.readdirSync(tmpRoot)) {
      const fullPath = path.join(tmpRoot, name);
      try {
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtimeMs > oneHourMs) {
          try {
            if (stat.isDirectory()) {
              const size = calculateDirSize(fullPath);
              fs.rmSync(fullPath, { recursive: true, force: true });
              freedBytes += size;
            } else {
              freedBytes += stat.size;
              fs.unlinkSync(fullPath);
            }
            cleaned++;
            console.log(`[CLEANUP] Removed: ${name} (${(freedBytes/1024/1024).toFixed(2)}MB freed)`);
          } catch (delErr) {
            console.error(`[CLEANUP] Failed to delete ${name}:`, delErr.message);
          }
        }
      } catch (e) {
      }
    }

    if (cleaned > 0) {
      console.log(`[CLEANUP] ✅ Cleaned ${cleaned} files (${(freedBytes/1024/1024).toFixed(2)}MB freed)`);
    }
  } catch (e) {
    console.error('Gagal cleanup temp lama:', e.message);
  }
}

function calculateDirSize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const stat = fs.statSync(path.join(dirPath, file));
      if (stat.isDirectory()) {
        size += calculateDirSize(path.join(dirPath, file));
      } else {
        size += stat.size;
      }
    }
  } catch (e) {
  }
  return size;
}

cleanupStaleTempFiles();
setInterval(cleanupStaleTempFiles, 15 * 60 * 1000);
setInterval(cleanupOldReleases, 60 * 60 * 1000);

const GITHUB_API = 'https://api.github.com';
const gh = axios.create({
  baseURL: GITHUB_API,
  timeout: 30000,
  headers: {
    Authorization: `token ${config.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  },
});

const RETRYABLE_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND']);
gh.interceptors.response.use(
  (res) => res,
  async (error) => {
    const cfg = error.config || {};
    cfg.__retryCount = cfg.__retryCount || 0;

    const isRetryable = RETRYABLE_CODES.has(error.code) || (error.response && error.response.status >= 500);
    if (isRetryable && cfg.__retryCount < 3) {
      cfg.__retryCount += 1;
      const delayMs = cfg.__retryCount * 1500;
      console.warn(`[GITHUB] Request gagal (${error.code || error.response?.status}), retry ${cfg.__retryCount}/3 dalam ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return gh(cfg);
    }
    return Promise.reject(error);
  }
);

const sessions = new Map();
let currentBuild = null;
const activeBuildCancellations = new Map();
let maintenanceMode = !!config.MAINTENANCE_MODE;

const OWNERS_FILE = path.join(config.DATA_DIR, 'owners.json');
const RESELLERS_FILE = path.join(config.DATA_DIR, 'resellers.json');

function ensureDataDir() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
}

function loadIdList(file) {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((id) => Number(id)).filter((id) => !Number.isNaN(id)) : [];
  } catch (e) {
    console.error(`Gagal load ${file}:`, e.message);
    return [];
  }
}

function saveIdList(file, list) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Gagal save ${file}:`, e.message);
  }
}

let extraOwners = loadIdList(OWNERS_FILE);
let resellers = loadIdList(RESELLERS_FILE);

function isSuperOwner(userId) {
  return config.SUPEROWNER_IDS.includes(userId);
}

async function checkUserJoinChannel(userId) {
  if (!config.REQUIRE_JOIN_CHANNEL) return true;
  try {
    const member = await bot.getChatMember(config.NOTIF_CHANNEL_ID, userId);
    const validStatus = ['member', 'administrator', 'creator', 'restricted'];
    return validStatus.includes(member.status);
  } catch (err) {
    console.error('[CHANNEL CHECK] Error:', err.message);
    return false;
  }
}

async function backupUserData(userId, username, firstName, buildData = null) {
  try {
    const backupFile = path.join(config.BACKUP_DIR, 'user.json');
    const timestamp = new Date().toISOString();

    let users = [];
    if (fs.existsSync(backupFile)) {
      try {
        users = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
        if (!Array.isArray(users)) users = [];
      } catch (e) {
        users = [];
      }
    }

    const idx = users.findIndex(u => u.userId === userId);
    const isNewUser = idx < 0;
    const existing = idx >= 0 ? users[idx] : {};

    const updated = {
      ...existing,
      userId,
      name: firstName,
      username: `@${username}`.replace('@@', '@'),
      joinedAt: existing.joinedAt || timestamp,
      lastActive: timestamp,
    };

    if (!isNewUser && !buildData) {
      console.log(`[BACKUP] User ${userId} sudah ada, skip backup (cegah spam)`);
      return { backupFile, isNewUser: false };
    }

    if (buildData) {
      if (!updated.buildHistory) updated.buildHistory = [];
      updated.buildHistory.push({ ...buildData, timestamp });
      if (updated.buildHistory.length > 100) {
        updated.buildHistory = updated.buildHistory.slice(-100);
      }
    }

    if (idx >= 0) {
      users[idx] = updated;
    } else {
      users.push(updated);
    }

    fs.writeFileSync(backupFile, JSON.stringify(users, null, 2), 'utf-8');
    console.log(`[BACKUP] User ${userId} saved to user.json (total: ${users.length})${isNewUser ? ' [NEW USER]' : ''}`);
    return { backupFile, isNewUser };
  } catch (err) {
    console.error('[BACKUP] Error:', err.message);
    return { backupFile: null, isNewUser: false };
  }
}

async function backupFileJson(userId, username) {
  try {
    const backupFile = path.join(config.BACKUP_DIR, 'user.json');
    if (!fs.existsSync(backupFile)) {
      console.error('[BACKUP ZIP] user.json tidak ditemukan, skip kirim zip');
      return;
    }

    const zip = new AdmZip();
    zip.addLocalFile(backupFile);
    const zipPath = path.join(config.BACKUP_DIR, `user_backup_${userId}_${Date.now()}.zip`);
    zip.writeZip(zipPath);

    const caption = `📦 <b>Backup User Baru</b>\n\n👤 User: @${username} (ID: <code>${userId}</code>)`;

    for (const ownerId of config.SUPEROWNER_IDS) {
      try {
        await bot.sendDocument(ownerId, zipPath, { caption, parse_mode: 'HTML' });
      } catch (sendErr) {
        console.error(`[BACKUP ZIP] Gagal kirim ke superowner ${ownerId}:`, sendErr.message);
      }
    }

    fs.unlink(zipPath, () => {});
  } catch (err) {
    console.error('[BACKUP ZIP] Error:', err.message);
  }
}

function getAllBackupUserIds() {
  try {
    const backupFile = path.join(config.BACKUP_DIR, 'user.json');
    if (!fs.existsSync(backupFile)) return [];
    const users = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
    if (!Array.isArray(users)) return [];
    return users.map(u => u.userId).filter(Boolean);
  } catch (err) {
    console.error('[BACKUP] Error reading user.json:', err.message);
    return [];
  }
}

function accessLevelLabel(level) {
  if (level === 'owner') return '👑 Owner';
  if (level === 'reseller') return '🥈 Reseller';
  return '👤 User';
}

function formatWaktuWIB(date = new Date()) {
  const jakarta = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const dd = String(jakarta.getDate()).padStart(2, '0');
  const mm = String(jakarta.getMonth() + 1).padStart(2, '0');
  const yyyy = jakarta.getFullYear();
  const hh = String(jakarta.getHours()).padStart(2, '0');
  const mi = String(jakarta.getMinutes()).padStart(2, '0');
  const ss = String(jakarta.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}.${mi}.${ss} WIB`;
}

async function sendNewUserNotificationToChannel(userId, username) {
  if (!config.NOTIF_CHANNEL_ID) return;

  try {
    const message = `<blockquote>ⓘ <b>USER BARU START BOT</b>
━━━━━━━━━━━━━━━━━━
ᯤ <b>User ID:</b> <code>${userId}</code>
ᯤ <b>Username:</b> @${username}
ᯤ <b>Waktu:</b> ${formatWaktuWIB()}
━━━━━━━━━━━━━━━━━━
</blockquote>`.trim();

    await bot.sendMessage(config.NOTIF_CHANNEL_ID, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[NOTIF NEW USER] Error:', err.message);
  }
}

async function sendNotificationToChannel(userId, username, projectName, status, accessLevel = 'user') {
  if (!config.NOTIF_CHANNEL_ID) return null;
  
  try {
    let message = '';
    if (status === 'start') {
      message = `<blockquote>🔨 <b>BUILD SEDANG DIPROSES</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${userId}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(accessLevel)}
🕒 <b>Waktu:</b> ${formatDuration(0)}
🏗️ <b>Project:</b> <i>Menunggu...</i>

${advancedProgressBar(0)}
━━━━━━━━━━━━━━━━━━━
</blockquote>
      `.trim();
    } else if (status === 'complete') {
      message = `<blockquote>✅ <b>BUILD SELESAI</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${userId}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(accessLevel)}
🏗️ <b>Project:</b> <b>${projectName}</b>

${advancedProgressBar(100)}
━━━━━━━━━━━━━━━━━━━
</blockquote>`.trim();
    } else if (status === 'error') {
      message = `<blockquote>❌ <b>BUILD GAGAL</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${userId}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(accessLevel)}
🏗️ <b>Project:</b> <b>${projectName}</b>

${advancedProgressBar(0)}
━━━━━━━━━━━━━━━━━━━
</blockquote>`.trim();
    }
    
    if (message) {
      const sentMsg = await bot.sendMessage(config.NOTIF_CHANNEL_ID, message, { parse_mode: 'HTML' });
      return sentMsg.message_id;
    }
  } catch (err) {
    console.error('[NOTIF] Error:', err.message);
  }
  return null;
}

async function updateBuildNotification(channelMessageId, userId, username, projectName, progress, elapsedSeconds, accessLevel = 'user') {
  if (!config.NOTIF_CHANNEL_ID || !channelMessageId) return;
  
  try {
    const message = `<blockquote>
🔨 <b>BUILD SEDANG BERJALAN</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${userId}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(accessLevel)}
🕒 <b>Waktu:</b> ${formatDuration(elapsedSeconds)}
🏗️ <b>Project:</b> <b>${projectName}</b>

${advancedProgressBar(progress)}
━━━━━━━━━━━━━━━━━━━
</blockquote>`.trim();
    
    await bot.editMessageText(message, {
      chat_id: config.NOTIF_CHANNEL_ID,
      message_id: channelMessageId,
      parse_mode: 'HTML'
    }).catch(err => {
      console.error('[NOTIF UPDATE] Error:', err.message);
    });
  } catch (err) {
    console.error('[NOTIF UPDATE] Error:', err.message);
  }
}

async function sendBackupToOwner(userId, username, backupFile) {
  try {
    if (!backupFile || !fs.existsSync(backupFile)) return;
    
    const fileStream = fs.createReadStream(backupFile);
    await bot.sendDocument(config.OWNER_CHAT_ID, fileStream, {
      caption: `📦 Backup User Data\n\n👤 User: @${username} (ID: ${userId})`
    });
  } catch (err) {
    console.error('[BACKUP SEND] Error:', err.message);
  }
}

function isOwner(chatId) {
  return chatId === config.OWNER_CHAT_ID || extraOwners.includes(chatId);
}

function isReseller(chatId) {
  return resellers.includes(chatId);
}

function accessLabel(chatId) {
  if (isOwner(chatId)) return '👑 Owner';
  if (isReseller(chatId)) return '🥈 Reseller';
  return '👤 User';
}

function displayName(from) {
  if (!from) return 'Unknown';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (from.username) return name ? `${name} (@${from.username})` : `@${from.username}`;
  return name || 'Unknown';
}

function minutesSince(ts) {
  return Math.floor((Date.now() - ts) / 60000);
}

function isMaintenanceBlocked(chatId) {
  return maintenanceMode && !isOwner(chatId);
}

async function maintenanceText(chatId) {
  await bot.sendMessage(chatId, config.MAINTENANCE_TEXT, { parse_mode: 'HTML' });
}

const ownerQueue = [];
const buildQueue = [];

function queueKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'ᯤ Cek Antrian', callback_data: 'queue_check', style: 'primary' },
          { text: 'ᯤ Refresh', callback_data: 'queue_refresh', style: 'primary' },
        ],
        [{ text: '❌ Batalkan Antrian', callback_data: 'queue_cancel', style: 'danger' }],
      ],
    },
  };
}

async function editOrSendText(chatId, messageId, text, keyboard) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...(keyboard || {}) });
  } catch (e) {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...(keyboard || {}) });
  }
}

function buildQueueStatusText(chatId) {
  const lines = [];
  lines.push('<blockquote>ⓘ <b>STATUS ANTRIAN BUILD</b>');
  lines.push('━━━━━━━━━━━━━━━━━');

  if (currentBuild) {
    const elapsedMin = Math.floor((Date.now() - currentBuild.startedAt) / 60000);
    lines.push(`🔨 Slot build: sedang jalan (tag <code>${currentBuild.tag}</code>, ${elapsedMin} menit)`);
  } else {
    lines.push('ᯤ Slot build: ✅ kosong');
  }

  if (ownerQueue.length > 0) {
    lines.push(`ᯤ Antrian owner (prioritas): <b>${ownerQueue.length}</b>`);
    ownerQueue.forEach((q, i) => {
      lines.push(`   ${i + 1}. ${displayName(q.from)} | ID: <code>${q.chatId}</code> | ⏱ ${minutesSince(q.queuedAt)} menit`);
    });
  }

  lines.push(`ᯤ Antrian reguler: <b>${buildQueue.length}</b> orang`);
  buildQueue.forEach((q, i) => {
    lines.push(`   ${i + 1}. ${displayName(q.from)} | ID: <code>${q.chatId}</code> | ${accessLabel(q.chatId)} | ⏱ ${minutesSince(q.queuedAt)} menit`);
  });

  const myOwnerItem = ownerQueue.find((q) => q.chatId === chatId);
  const myItem = buildQueue.find((q) => q.chatId === chatId);

  if (myOwnerItem) {
    lines.push(`ᯤ Posisi kamu: <b>${ownerQueue.indexOf(myOwnerItem) + 1}</b> (👑 Owner, prioritas utama)`);
  } else if (myItem) {
    const pos = buildQueue.indexOf(myItem) + 1;
    lines.push(`ᯤ Posisi kamu: <b>${pos}</b> dari ${buildQueue.length} (${accessLabel(chatId)})`);
  } else if (currentBuild && currentBuild.chatId === chatId) {
    lines.push('ᯤ Status kamu: 🔨 sedang diproses sekarang');
  } else {
    lines.push('ᯤ Status kamu: tidak ada dalam antrian');
  }

  lines.push('━━━━━━━━━━━━━━━━━</blockquote>');
  return lines.join('\n');
}

async function sendQueueStatus(chatId, messageIdToEdit = null) {
  const text = buildQueueStatusText(chatId);
  if (messageIdToEdit) {
    await editOrSendText(chatId, messageIdToEdit, text, queueKeyboard());
    return;
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...queueKeyboard() });
}

function buildNewQueueStatusText() {
  let text = '╭──〔 ᯤ STATUS BUILD 〕──╮\n\n';
  
  const waiting = 0;
  const queueCount = buildQueue.length;
  const uploading = currentBuild ? 1 : 0;
  
  text += `⏳ Menunggu : ${waiting}\n`;
  text += `📥 Antri    : ${queueCount}\n`;
  text += `☁️ Upload   : 0\n`;
  text += `ᯤ Building : ${uploading}\n\n`;
  
  text += '╰────────────────────────────╯\n\n';
  
  if (currentBuild) {
    const elapsedMin = Math.floor((Date.now() - currentBuild.startedAt) / 60000);
    const elapsedSec = Math.floor((Date.now() - currentBuild.startedAt) / 1000) % 60;
    text += `ᯤ SEDANG BUILD SEKARANG:\n`;
    text += `   👉 Build Process (Elapsed: ${elapsedMin}m ${elapsedSec}s)\n\n`;
  }
  
  text += `🔥 Build Aktif (${(currentBuild ? 1 : 0) + buildQueue.length})\n\n`;
  
  let buildNum = 1;
  if (currentBuild) {
    const elapsedMin = Math.floor((Date.now() - currentBuild.startedAt) / 60000);
    const elapsedSec = Math.floor((Date.now() - currentBuild.startedAt) / 1000) % 60;
    text += `${buildNum}. 🔨 Build Process (👤 User)\n`;
    text += `   ᯤ Status : ᯤ Sedang Building\n`;
    text += `   ᯤ Mode   : 🚀 Release\n`;
    text += `   ᯤ Aktif  : ${elapsedMin} Menit ${elapsedSec} Detik\n\n`;
    buildNum++;
  }
  
  buildQueue.forEach((q, i) => {
    const queuedMin = minutesSince(q.queuedAt);
    const username = q.from.username ? `@${q.from.username}` : 'Unknown';
    text += `${buildNum}. 📥 ${username} (👤 User)\n`;
    text += `ᯤ Status : 📥 Antri Slot Build\n`;
    text += `ᯤ Posisi : #${i + 1}\n`;
    text += `ᯤ Mode   : 🚀 ${q.session?.buildMode === 'debug' ? 'Debug' : 'Release'}\n`;
    text += `ᯤ Aktif  : ${queuedMin} Menit\n\n`;
    buildNum++;
  });
  
  text += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
  text += '✅ Sukses (Aplikasi Berhasil Dibuat) : 576 Build\n';
  text += '🔴 Gagal (Karena Error Code) : 191 Build\n';
  text += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
  
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  text += `🕒 ${hours}.${minutes}.${seconds} WIB`;
  
  return text;
}

async function sendNewQueueStatus(chatId) {
  const text = buildNewQueueStatusText();
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function requestBuild(chatId, from, doc, session, zipMessageId) {
  const userId = from.id;
  const username = from.username || 'unknown';
  const owner = isOwner(chatId);
  const reseller = !owner && isReseller(chatId);
  const accessLevel = owner ? 'owner' : reseller ? 'reseller' : 'normal';
  
  if (config.REQUIRE_JOIN_CHANNEL) {
    const hasJoined = await checkUserJoinChannel(userId);
    if (!hasJoined) {
      const channelLink = config.NOTIF_CHANNEL_USERNAME;
      return bot.sendMessage(
        chatId,
        `<b>⚠️ Wajib Join Channel Terlebih Dahulu!</b>\n\n` +
        `Untuk bisa upload & build, silahkan join channel kami terlebih dahulu:\n\n` +
        `🔗 ${channelLink}\n\n` +
        `Setelah join, silahkan upload zip kamu lagi.`,
        { parse_mode: 'HTML' }
      );
    }
  }
  
  await backupUserData(userId, username, from.first_name, { event: 'build_request', buildMode: session?.buildMode });

  const totallyIdle = !currentBuild && buildQueue.length === 0 && ownerQueue.length === 0;
  if (totallyIdle) {
    const channelMsgId = await sendNotificationToChannel(from.id, username, '-', 'start', accessLevel).catch(() => null);
    
    runBuildFlow(chatId, from, doc, session, zipMessageId, channelMsgId)
      .catch((e) => console.error('runBuildFlow error:', e.message));
    return;
  }

  if (accessLevel === 'owner') {
    const item = { chatId, from, doc, session, zipMessageId, accessLevel, queuedAt: Date.now() };
    ownerQueue.push(item);
    const position = ownerQueue.length;
    const msg = await bot.sendMessage(
      chatId,
      `<blockquote>⏳ <b>ANTRIAN OWNER (PRIORITAS UTAMA)</b>\n━━━━━━━━━━━━━━━━━\nᯤ Akses owner tidak dihitung di antrian biasa.\nᯤ Build kamu akan diproses duluan begitu slot build kosong.\nᯤ Posisi di antrian owner: <b>${position}</b>\n\n⏳ Mohon tunggu, bot otomatis lanjut download & proses zip kamu begitu giliran tiba.</blockquote>`,
      { parse_mode: 'HTML', ...queueKeyboard() }
    );
    item.queueMsgId = msg.message_id;
    return;
  }

  const item = { chatId, from, doc, session, zipMessageId, accessLevel, queuedAt: Date.now() };
  if (accessLevel === 'reseller') {
    const insertIndex = Math.min(1, buildQueue.length);
    buildQueue.splice(insertIndex, 0, item);
  } else {
    buildQueue.push(item);
  }

  const position = buildQueue.indexOf(item) + 1;
  const label = accessLevel === 'reseller' ? '🥈 Reseller' : '👤 User';
  const msg = await bot.sendMessage(
    chatId,
    `<blockquote>⏳ <b>MASUK ANTRIAN BUILD</b>\n━━━━━━━━━━━━━━━━━\nᯤ Akses: ${label}\nᯤ Posisi antrian: <b>${position}</b> dari ${buildQueue.length}\n\n⏳ Mohon tunggu antrian selesai dulu, bot otomatis lanjut download & proses zip kamu begitu giliran tiba.</blockquote>`,
    { parse_mode: 'HTML', ...queueKeyboard() }
  );
  item.queueMsgId = msg.message_id;
}

async function processQueue() {
  if (currentBuild) return;

  let next = null;
  if (ownerQueue.length > 0) {
    next = ownerQueue.shift();
  } else if (buildQueue.length > 0) {
    next = buildQueue.shift();
  }

  if (!next) return;

  bot.sendMessage(
    next.chatId,
    '✅ <b>Giliran kamu tiba!</b> Bot otomatis lanjut mengunduh & memproses zip kamu sekarang...',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  
  const username = next.from.username || 'unknown';
  const accessLevel = next.accessLevel || 'user';
  const channelMsgId = await sendNotificationToChannel(next.from.id, username, '-', 'start', accessLevel).catch(() => null);
  
  next.channelNotifMsgId = channelMsgId;

  runBuildFlow(next.chatId, next.from, next.doc, next.session, next.zipMessageId, next.channelNotifMsgId)
    .catch((e) => console.error('runBuildFlow error (dari antrian):', e.message));
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} Jam`);
  if (m > 0) parts.push(`${m} Menit`);
  if (s > 0 || parts.length === 0) parts.push(`${s} Detik`);
  return parts.join(" ");
}

function elapsedSec(since) {
  return Math.floor((Date.now() - since) / 1000);
}

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return bar;
}

function advancedProgressBar(pct) {
  pct = Math.min(100, Math.max(0, pct));
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  return `${bar} ${pct.toFixed(1)}%`;
}

async function debugErrorfile(chatId, fullLogText, chunkSize = 3500) {
  if (!fullLogText || fullLogText.trim().length === 0) {
    console.warn('[BUILD] Log kosong, skip kirim error');
    return;
  }

  const lines = fullLogText.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + line + "\n").length > chunkSize) {
      if (current.trim().length > 0) {
        chunks.push(current.trim());
      }
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  console.log(`[BUILD] Total ${chunks.length} chunk(s) untuk error log`);

  for (let i = 0; i < chunks.length; i++) {
    const header = chunks.length > 1 
      ? `📋 <b>Log Error — Bagian ${i + 1}/${chunks.length}</b>\n` 
      : `📋 <b>Log Error Lengkap</b>\n`;
    
    try {
      const safeLog = sanitizeCodeBlock(chunks[i]);
      const message = `${header}<pre>${safeLog}</pre>`;
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true 
      });
      
      if (i < chunks.length - 1) {
        await sleep(500);
      }
    } catch (e) {
      console.error(`[BUILD] Gagal kirim bagian log error ${i + 1}/${chunks.length}:`, e.message);
      
      try {
        const logFile = tmpPath(`build_error_part_${i + 1}_${Date.now()}.txt`);
        fs.writeFileSync(logFile, chunks[i], 'utf-8');
        
        await bot.sendMessage(chatId, `📄 <b>Error Log Part ${i + 1}/${chunks.length}</b> (file terlalu panjang)`, {
          parse_mode: 'HTML'
        });
        await sendDocumentViaGram(chatId, logFile, `error-log-part-${i + 1}.txt`);
        
        fs.unlinkSync(logFile);
      } catch (e2) {
        console.error(`[BUILD] Fallback file gagal juga:`, e2.message);
      }
    }
  }
}

function sanitizeCodeBlock(text) {
  return escapeHtml(String(text)).slice(0, 4000);
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔨 Build APK', callback_data: 'menu_build', style: "primary" }],
        [{ text: '📋 Cek Antrian', callback_data: 'queue_check', style: "primary" }],
      ],
    },
  };
}

function buildTypeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'ⓘ Release', callback_data: 'type_release', style: "success" },
          { text: 'ᯤ Debug', callback_data: 'type_debug', style: "primary" },
        ],
        [{ text: '🔍 Analyze Only', callback_data: 'type_analyze', style: "danger" }],
        [{ text: '🔙 Kembali', callback_data: 'menu_back', style: "primary" }],
      ],
    },
  };
}

function zipPromptKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Kembali', callback_data: 'menu_back', style: "primary" }],
      ],
    },
  };
}

function buildStatusKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batalkan Build', callback_data: 'build_cancel', style: "danger" }],
      ],
    },
  };
}
function cleanHtmlText(text) {
  if (!text) return "";
  return String(text).replace(/<\/?tg-thinking>/gi, "").trim();
}

async function sendRichMessage(chatId, htmlContent, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    rich_message: {
      html: cleanHtmlText(htmlContent)
    }
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return (await axios.post(`https://api.telegram.org/bot${config.TokenBot}/sendRichMessage`, payload)).data?.result;
}
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'User';
  const username = msg.from.username || 'tidak ada';

  if (isMaintenanceBlocked(chatId)) {
    return maintenanceText(chatId);
  }
  
  const { isNewUser } = await backupUserData(userId, username, firstName, null);

  if (isNewUser) {
    backupFileJson(userId, username).catch(err => {
      console.error('[BACKUP ZIP] Error saat kirim zip ke superowner:', err.message);
    });
    sendNewUserNotificationToChannel(userId, username).catch(err => {
      console.error('[NOTIF NEW USER] Error saat kirim notif ke channel:', err.message);
    });
  }
  
  if (config.REQUIRE_JOIN_CHANNEL) {
    const hasJoined = await checkUserJoinChannel(userId);
    if (!hasJoined) {
      const channelLink = config.NOTIF_CHANNEL_USERNAME;
      return bot.sendMessage(chatId, 
`<b>⚠️ Wajib Join Channel Terlebih Dahulu!</b>\n\n` +
  `Untuk bisa menggunakan bot ini, silahkan join channel kami terlebih dahulu:\n\n` +
  `🔗 ${channelLink}\n\n` +
  `Setelah join, silahkan ketik /start lagi.`,
   {
     parse_mode: 'HTML',
     reply_markup: {
       inline_keyboard: [
         [
          { text: "Join Channel", url: "https://t.me/NtedCrasherExec", style: "primary" }
         ]
       ]
     }
   });
 }
}

  const fullText = `<tg-slideshow>
  <img src="https://files.catbox.moe/1tdt9n.jpg" />
  <img src="https://files.catbox.moe/m9cm8w.jpg" />
  <img src="https://files.catbox.moe/0mlkz1.jpg" />
</tg-slideshow>

<table bordered striped>
  <tr><th>ⓘ Acces</th><th>ⓘ Price</th></tr>
  <tr><td>ᯤ Reseller</td><td><b>Rp15.000 | 15K</b></td></tr>
  <tr><td>ᯤ Owner</td><td><b>Rp25.000 | 25K</b></td></tr>
</table>

<table bordered striped>
  <tr><th>ⓘ Informasi</th><th>ⓘ Detail</th></tr>
  <tr><td>ᯤ UserID</td><td><code>${userId}</code></td></tr>
  <tr><td>ᯤ Username</td><td>@${username}</td></tr>
  <tr><td>ᯤ Nama</td><td>${firstName}</td></tr>
  <tr><td>ᯤ Owner</td><td>${isOwner ? '✅ Owner access' : '❌ Tidak'}</td></tr>
  <tr><td>ᯤ Reseller</td><td>${isReseller ? '✅ Reseller access' : '❌ Tidak'}</td></tr>
</table>

<details>
  <summary><b>☕ Update Vip Version</b></summary>
  <ul>
    <li>Build lebih cepat ✅</li>
    <li>Antri tidak lama ✅</li>
    <li>Owner tidak antri ✅</li>
    <li>Reseller prioritas 1 ✅</li>
    <li>Build lebih simple ✅</li>
    <li>Error log lebih jelas ✅</li>
  </ul>
</details>

<footer>© Buy Acces: <a href="https://t.me/NtedBitch">NtedBitch</a></footer>`;
  const buttons = {
    inline_keyboard: [
        [{ text: '🔨 Build APK', callback_data: 'menu_build', style: "primary" }],
        [{ text: '📋 Cek Antrian', callback_data: 'queue_check', style: "primary" }],
      ],
    };
  await sendRichMessage(chatId, fullText, buttons);
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  if (isMaintenanceBlocked(chatId)) {
    return maintenanceText(chatId);
  }

  if (!currentBuild) {
    return bot.sendMessage(chatId, '✅ Slot build sedang kosong, silakan build.');
  }
  const elapsedMin = Math.floor((Date.now() - currentBuild.startedAt) / 60000);
  bot.sendMessage(
    chatId,
    `⏳ Sedang ada build berjalan (tag: <code>${currentBuild.tag}</code>, sudah ${elapsedMin} menit).`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/cleanup/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isOwner(chatId)) {
    return;
  }

  try {
    await bot.sendMessage(chatId, '🧹 Sedang cleanup temp files dan GitHub releases...');
    
    cleanupStaleTempFiles();
    await cleanupOldReleases(1 * 60 * 60 * 1000);
    
    const { exec } = require('child_process');
    exec('df -h / | tail -1', (err, stdout) => {
      const diskInfo = err ? 'tidak bisa baca' : stdout.trim();
      bot.sendMessage(chatId, 
        `✅ <b>Cleanup selesai!</b>\n\n` +
        `Disk usage:\n<code>${diskInfo}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Cleanup error: ${err.message}`);
  }
});

bot.onText(/\/maintenance(?:\s+(on|off))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!isOwner(chatId)) {
    return;
  }

  const arg = match[1];
  if (arg === 'on') maintenanceMode = true;
  else if (arg === 'off') maintenanceMode = false;
  else maintenanceMode = !maintenanceMode;

  await bot.sendMessage(
    chatId,
    `🛠️ Mode maintenance sekarang: <b>${maintenanceMode ? 'ON 🔴' : 'OFF 🟢'}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/addowner(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isSuperOwner(chatId)) return;

  const target = match[1] ? parseInt(match[1], 10) : null;
  if (!target) {
    return bot.sendMessage(chatId, '❌ Format salah. Gunakan: <code>/addowner 123456789</code>', { parse_mode: 'HTML' });
  }
  if (isOwner(target)) {
    return bot.sendMessage(chatId, `ℹ️ <code>${target}</code> sudah menjadi Owner.`, { parse_mode: 'HTML' });
  }

  extraOwners.push(target);
  saveIdList(OWNERS_FILE, extraOwners);

  if (resellers.includes(target)) {
    resellers = resellers.filter((id) => id !== target);
    saveIdList(RESELLERS_FILE, resellers);
  }

  await bot.sendMessage(
    chatId,
    `✅ <code>${target}</code> berhasil ditambahkan sebagai <b>Owner</b>.\nUser ini sekarang tidak perlu antri build lagi.`,
    { parse_mode: 'HTML' }
  );
  bot.sendMessage(
    target,
    '🎉 Kamu baru saja ditambahkan sebagai <b>Owner</b> bot ini. Kamu tidak perlu antri lagi setiap build.',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.onText(/\/delowner(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isSuperOwner(chatId)) return;

  const target = match[1] ? parseInt(match[1], 10) : null;
  if (!target) {
    return bot.sendMessage(chatId, '❌ Format salah. Gunakan: <code>/delowner 123456789</code>', { parse_mode: 'HTML' });
  }
  if (target === config.OWNER_CHAT_ID) {
    return bot.sendMessage(chatId, '❌ Tidak bisa menghapus super owner.', { parse_mode: 'HTML' });
  }
  if (!extraOwners.includes(target)) {
    return bot.sendMessage(chatId, `ℹ️ <code>${target}</code> bukan Owner tambahan.`, { parse_mode: 'HTML' });
  }

  extraOwners = extraOwners.filter((id) => id !== target);
  saveIdList(OWNERS_FILE, extraOwners);

  await bot.sendMessage(chatId, `✅ <code>${target}</code> dihapus dari daftar Owner.`, { parse_mode: 'HTML' });
});

bot.onText(/\/addreseller(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;

  const target = match[1] ? parseInt(match[1], 10) : null;
  if (!target) {
    return bot.sendMessage(chatId, '❌ Format salah. Gunakan: <code>/addreseller 123456789</code>', { parse_mode: 'HTML' });
  }
  if (isOwner(target)) {
    return bot.sendMessage(chatId, `ℹ️ <code>${target}</code> adalah Owner, gak perlu jadi Reseller.`, { parse_mode: 'HTML' });
  }
  if (resellers.includes(target)) {
    return bot.sendMessage(chatId, `ℹ️ <code>${target}</code> sudah menjadi Reseller.`, { parse_mode: 'HTML' });
  }

  resellers.push(target);
  saveIdList(RESELLERS_FILE, resellers);

  await bot.sendMessage(
    chatId,
    `✅ <code>${target}</code> berhasil ditambahkan sebagai <b>Reseller</b>.\nAntrian build user ini otomatis masuk ke posisi ke-2.`,
    { parse_mode: 'HTML' }
  );
  bot.sendMessage(
    target,
    '🎉 Kamu baru saja ditambahkan sebagai <b>Reseller</b> bot ini. Antrian build kamu otomatis prioritas di posisi ke-2.',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.onText(/\/delreseller(?:\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;

  const target = match[1] ? parseInt(match[1], 10) : null;
  if (!target) {
    return bot.sendMessage(chatId, '❌ Format salah. Gunakan: <code>/delreseller 123456789</code>', { parse_mode: 'HTML' });
  }
  if (!resellers.includes(target)) {
    return bot.sendMessage(chatId, `ℹ️ <code>${target}</code> bukan Reseller.`, { parse_mode: 'HTML' });
  }

  resellers = resellers.filter((id) => id !== target);
  saveIdList(RESELLERS_FILE, resellers);

  await bot.sendMessage(chatId, `✅ <code>${target}</code> dihapus dari daftar Reseller.`, { parse_mode: 'HTML' });
});

bot.onText(/\/listaccess/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;

  const ownerList = [config.OWNER_CHAT_ID, ...extraOwners]
    .map((id) => `<code>${id}</code>${id === config.OWNER_CHAT_ID ? ' (super owner)' : ''}`)
    .join('\n') || '(kosong)';
  const resellerList = resellers.map((id) => `<code>${id}</code>`).join('\n') || '(kosong)';

  await bot.sendMessage(
    chatId,
    `<blockquote>👑 <b>Daftar Owner</b>\n${ownerList}\n\n🥈 <b>Daftar Reseller</b>\n${resellerList}</blockquote>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/(cekantrian|antrian|queue|status)/, async (msg) => {
  const chatId = msg.chat.id;
  if (isMaintenanceBlocked(chatId)) {
    return maintenanceText(chatId);
  }
  await sendNewQueueStatus(chatId);
});

async function processBroadcastCommand(msg, captionOverride) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isSuperOwner(userId)) {
    return bot.sendMessage(chatId, '❌ Command ini hanya untuk superowner.', { parse_mode: 'HTML' });
  }

  const sourceMsg = msg.reply_to_message || msg;

  const hasContent =
    msg.reply_to_message ||
    (msg.text && msg.text.replace(/^\/broadcast\s*/i, '').trim()) ||
    msg.photo || msg.video || msg.document || msg.audio ||
    msg.voice || msg.sticker || msg.animation || msg.video_note;

  if (!hasContent) {
    return bot.sendMessage(
      chatId,
      '❌ <b>Tidak ada konten untuk dibroadcast.</b>\n\n' +
      '<b>Cara pakai:</b>\n' +
      '• Reply pesan apapun lalu kirim <code>/broadcast</code>\n' +
      '• Kirim <code>/broadcast Teks pesan</code>\n' +
      '• Kirim foto/video/dll + caption <code>/broadcast Teks caption</code>\n\n' +
      '<b>Support semua tipe:</b> teks, foto, video, dokumen, audio, voice, sticker, GIF, dll.',
      { parse_mode: 'HTML' }
    );
  }

  let contentType = '📝 Teks';
  if (sourceMsg.photo) contentType = '🖼 Foto';
  else if (sourceMsg.video) contentType = '🎥 Video';
  else if (sourceMsg.document) contentType = '📄 Dokumen';
  else if (sourceMsg.audio) contentType = '🎵 Audio';
  else if (sourceMsg.voice) contentType = '🎤 Voice';
  else if (sourceMsg.sticker) contentType = '🎭 Sticker';
  else if (sourceMsg.animation) contentType = '🎞 GIF';
  else if (sourceMsg.video_note) contentType = '⭕ Video Note';

  const previewCaption = captionOverride !== undefined
    ? captionOverride
    : (sourceMsg.caption || sourceMsg.text || '');
  const previewText = previewCaption
    ? `\n<blockquote>${previewCaption.slice(0, 200)}${previewCaption.length > 200 ? '...' : ''}</blockquote>`
    : '';

  const backupUserCount = getAllBackupUserIds().length;
  const keyboard = {
    inline_keyboard: [
      [{ text: 'Share Ke Owner', callback_data: 'bc_owners' }],
      [{ text: 'Share Ke Ress', callback_data: 'bc_resellers' }],
      [{ text: 'Share All User', callback_data: 'bc_all' }],
      [{ text: `Share Ke user json`, callback_data: 'bc_users' }],
      [{ text: '❌ Batal', callback_data: 'bc_cancel' }]
    ],
  };

  sessions.set(userId, {
    broadcastMode: true,
    broadcastFromChatId: sourceMsg.chat.id,
    broadcastMessageId: sourceMsg.message_id,
    broadcastCaptionOverride: captionOverride,
    broadcastTime: Date.now(),
  });

  await bot.sendMessage(chatId,
`<blockquote>
ⓘ Broadcast Manager
━━━━━━━━━━━━━━━━
ᯤ <b>aktif:</b> ${backupUserCount} user
ᯤ <b>Tipe pesan:</b> ${contentType}${previewText}

━━━━━━━━━━━━━━━━
<b>Pilih target broadcast:</b>
`,
  {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Share Ke Ress', callback_data: 'bc_resellers', style: "primary" }],
      [{ text: 'Share All User', callback_data: 'bc_all', style: "primary" }],
      [{ text: `Share Ke user json`, callback_data: 'bc_users', style: "success" }],
      [{ text: '❌ Batal', callback_data: 'bc_cancel', style: "danger" }],
      ],
    },
  });
}

bot.onText(/\/broadcast/, async (msg) => {
  if (!msg.reply_to_message &&
      (msg.photo || msg.video || msg.document || msg.audio ||
       msg.voice || msg.sticker || msg.animation || msg.video_note)) return;

  const extraText = msg.text?.replace(/^\/broadcast\s*/i, '').trim() || undefined;
  await processBroadcastCommand(msg, extraText);
});

bot.on('message', async (msg) => {
  if (!msg.caption || !msg.caption.match(/^\/broadcast/i)) return;
  if (!msg.photo && !msg.video && !msg.document && !msg.audio &&
      !msg.voice && !msg.sticker && !msg.animation && !msg.video_note) return;

  const customCaption = msg.caption.replace(/^\/broadcast\s*/i, '').trim();
  await processBroadcastCommand(msg, customCaption);
});

async function handleBroadcast(query, target) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;

  const session = sessions.get(userId);
  if (!session || !session.broadcastMode || !session.broadcastFromChatId) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Session broadcast expired', show_alert: true });
  }

  const fromChatId = session.broadcastFromChatId;
  const messageId = session.broadcastMessageId;
  const captionOverride = session.broadcastCaptionOverride;

  let targetList = [];
  let targetName = '';

  if (target === 'owners') {
    targetList = [config.OWNER_CHAT_ID, ...extraOwners];
    targetName = 'Owner';
  } else if (target === 'resellers') {
    targetList = resellers;
    targetName = 'Reseller';
  } else if (target === 'all') {
    targetList = [config.OWNER_CHAT_ID, ...extraOwners, ...resellers];
    targetName = 'Semua User';
  } else if (target === 'users') {
    targetList = getAllBackupUserIds();
    targetName = `User Backup (${targetList.length} user)`;
  } else {
    sessions.delete(userId);
    return bot.editMessageText(
      '❌ Broadcast dibatalkan.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  await bot.answerCallbackQuery(query.id);

  await bot.editMessageText(
    `⏳ <b>Sedang mengirim broadcast...</b>\n\n📢 Target: <b>${targetName}</b>\n📨 Total: <b>${targetList.length}</b>`,
    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
  );

  let sent = 0;
  let failed = 0;

  for (const targetId of targetList) {
    try {
      const copyOpts = {};
      if (captionOverride !== undefined) {
        copyOpts.caption = captionOverride;
        copyOpts.parse_mode = 'HTML';
      }
      await bot.copyMessage(targetId, fromChatId, messageId, copyOpts);
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      failed++;
      console.error(`[BROADCAST] Failed to send to ${targetId}:`, err.message);
    }
  }

  sessions.delete(userId);

  await bot.editMessageText(
    `✅ <b>Broadcast Selesai!</b>\n\n` +
    `📢 Target: <b>${targetName}</b>\n` +
    `✅ Berhasil: <b>${sent}</b>\n` +
    `❌ Gagal: <b>${failed}</b>`,
    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
  );
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (isMaintenanceBlocked(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: '🛠️ Bot sedang maintenance, coba lagi nanti ya.', show_alert: true });
    return;
  }

  try {
    if (data === 'bc_owners') {
      return handleBroadcast(query, 'owners');
    } else if (data === 'bc_resellers') {
      return handleBroadcast(query, 'resellers');
    } else if (data === 'bc_all') {
      return handleBroadcast(query, 'all');
    } else if (data === 'bc_users') {
      return handleBroadcast(query, 'users');
    } else if (data === 'bc_cancel') {
      sessions.delete(query.from.id);
      return bot.editMessageText('❌ Broadcast dibatalkan.', { chat_id: chatId, message_id: messageId });
    }
    
    if (data === 'menu_build') {
      sessions.set(chatId, { awaiting: 'zip' });
      await editOrSend(
        chatId,
        messageId,
        `<blockquote>ⓘ <b>TUTORIAL BUILD PROJECT</b>
═════════════════
ᯤ Kirimkan kan file berupa <b>ZIP</b>
ᯤ Maximum size <b>2GB</b>
ᯤ Wajib ada <b>pubspec.yaml</b>

═════════════════
ⓘ Kirimkan zip anda sekarang!
</blockquote>`,
        zipPromptKeyboard(),
        true
      );
    }

    if (data === 'menu_back') {
      sessions.delete(chatId);
      await editOrSend(chatId, messageId, config.START_TEXT, mainMenuKeyboard(), true);
    }

    if (data === 'type_release' || data === 'type_debug' || data === 'type_analyze') {
      const session = sessions.get(chatId);

      if (!session || session.awaiting !== 'type' || !session.doc) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Kirim file zip dulu ya.' });
        return;
      }

      const onlyAnalyze = data === 'type_analyze';
      const buildType = data === 'type_debug' ? 'debug' : 'release';
      session.buildType = buildType;
      session.onlyAnalyze = onlyAnalyze;

      const label = onlyAnalyze ? 'ANALYZE ONLY' : buildType.toUpperCase();
      const doc = session.doc;
      const zipMessageId = session.zipMessageId;
      const from = query.from;

      await bot.answerCallbackQuery(query.id, { text: `✅ Mode: ${label}` });
      await bot.sendMessage(chatId, `<blockquote>✅ <b>SUKSES PILIH MODE</b>
═════════════════
ᯤ Mode: <b>${label}</b> dipilih

═════════════════
⏳ Sedang proses permintaan build....
</blockquote>`, { parse_mode: 'HTML' });

      sessions.delete(chatId);
      requestBuild(chatId, from, doc, session, zipMessageId)
        .catch((e) => console.error('requestBuild error:', e.message));
      return;
    }

    if (data === 'build_cancel') {
      if (currentBuild && currentBuild.chatId === chatId) {
        activeBuildCancellations.set(currentBuild.tag, true);
        await bot.answerCallbackQuery(query.id, { text: '⏹️ Batalkan build sedang diproses...' });
      } else {
        await bot.answerCallbackQuery(query.id, { text: '❌ Tidak ada build yang dapat dibatalkan' });
      }
    }

    if (data === 'queue_check' || data === 'queue_refresh') {
      await sendQueueStatus(chatId, messageId);
      await bot.answerCallbackQuery(query.id, { text: data === 'queue_refresh' ? '🔄 Antrian diperbarui' : '📋 Status antrian' });
    }

    if (data === 'queue_cancel') {
      const ownerIdx = ownerQueue.findIndex((q) => q.chatId === chatId);
      const idx = buildQueue.findIndex((q) => q.chatId === chatId);

      if (ownerIdx !== -1) {
        ownerQueue.splice(ownerIdx, 1);
        await editOrSendText(chatId, messageId, '⏹️ <b>Kamu sudah keluar dari antrian owner.</b>');
        await bot.answerCallbackQuery(query.id, { text: '✅ Dibatalkan dari antrian.' });
      } else if (idx !== -1) {
        buildQueue.splice(idx, 1);
        await editOrSendText(chatId, messageId, '⏹️ <b>Kamu sudah keluar dari antrian build.</b>');
        await bot.answerCallbackQuery(query.id, { text: '✅ Dibatalkan dari antrian.' });
      } else if (currentBuild && currentBuild.chatId === chatId) {
        activeBuildCancellations.set(currentBuild.tag, true);
        await bot.answerCallbackQuery(query.id, { text: '⏹️ Batalkan build sedang diproses...' });
      } else {
        await bot.answerCallbackQuery(query.id, { text: 'ℹ️ Kamu tidak ada dalam antrian.' });
      }
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('callback_query error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan, coba lagi.' });
  }
});

async function editOrSend(chatId, messageId, text, keyboard, useCaption) {
  try {
    if (useCaption) {
      await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...keyboard });
    } else {
      await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, ...keyboard });
    }
  } catch (e) {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
  }
}

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (isMaintenanceBlocked(chatId)) {
    return maintenanceText(chatId);
  }

  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.zip')) {
    return bot.sendMessage(chatId, '❌ File harus berformat .zip');
  }

  const maxBytes = config.MaxSize * 1024 * 1024;
  if (doc.file_size && doc.file_size > maxBytes) {
    return bot.sendMessage(chatId, `❌ Ukuran file melebihi batas ${config.MaxSize}MB.`);
  }

  const prevSession = sessions.get(chatId) || {};
  sessions.set(chatId, { ...prevSession, awaiting: 'type', doc, zipMessageId: msg.message_id });

  await bot.sendMessage(
    chatId,
    `✅ File zip diterima!\n\n🔨 Pilih tipe build yang kamu inginkan:`,
    buildTypeKeyboard()
  );
});

async function runBuildFlow(chatId, from, doc, session, zipMessageId, channelNotifMsgId = null) {
  const tag = `${chatId}-${Date.now()}`;
  let accessLevel = 'user';
  if (isOwner(chatId)) accessLevel = 'owner';
  else if (isReseller(chatId)) accessLevel = 'reseller';
  
  currentBuild = { 
    chatId, 
    tag, 
    startedAt: Date.now(), 
    status: 'uploading', 
    progress: 0, 
    channelNotifMsgId,
    userId: from.id,
    username: from.username || 'unknown',
    accessLevel
  };
  const startTime = Date.now();

  const statusMsg = await bot.sendMessage(chatId, '⬇️ Mengunduh file zip...', buildStatusKeyboard());
  const tmpDir = tmpPath(`build-${tag}`);
  
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  
  const zipPath = path.join(tmpDir, doc.file_name);
  let releaseId = null;
  let projectDisplay = 'terdeteksi';

  const setStatus = (text, progressPct = null) => {
    if (progressPct !== null) {
      currentBuild.progress = progressPct;
    }
    return bot.editMessageText(text, { 
      chat_id: chatId, 
      message_id: statusMsg.message_id, 
      parse_mode: 'HTML', 
      ...buildStatusKeyboard() 
    }).catch(() => {});
  };

  try {
    console.log('[BUILD] 🧹 Pre-cleanup sebelum download...');
    cleanupStaleTempFiles();
    cleanupOldReleases(30 * 60 * 1000);
    try {
      const tmpRoot = config.DirFile;
      if (fs.existsSync(tmpRoot)) {
        const fiveMinMs = 5 * 60 * 1000;
        let forceCleanedCount = 0;
        for (const name of fs.readdirSync(tmpRoot)) {
          const fullPath = path.join(tmpRoot, name);
          try {
            const stat = fs.statSync(fullPath);
            if (Date.now() - stat.mtimeMs > fiveMinMs && fullPath !== tmpDir) {
              fs.rmSync(fullPath, { recursive: true, force: true });
              forceCleanedCount++;
            }
          } catch (e) {}
        }
        if (forceCleanedCount > 0) {
          console.log(`[BUILD] 🧹 Force cleaned ${forceCleanedCount} old files`);
        }
      }
    } catch (e) {
      console.warn('[BUILD] Force cleanup warning:', e.message);
    }
    
    try {
      const diskCheck = await new Promise((resolve) => {
        const { exec } = require('child_process');
        exec("df ./tmp | tail -1 | awk '{print $4}'", (err, stdout) => {
          if (err) {
            resolve(null);
          } else {
            const freeKB = parseInt(stdout.trim());
            resolve(freeKB * 1024);
          }
        });
      });
      
      const minFreeBytes = 1024 * 1024 * 1024;
      if (diskCheck !== null && diskCheck < minFreeBytes) {
        throw new Error(`❌ Disk space kurang dari 1GB (hanya ${(diskCheck/1024/1024/1024).toFixed(2)}GB tersedia). Cleanup diperlukan.`);
      }
    } catch (spaceErr) {
      console.warn('[BUILD] Disk check:', spaceErr.message);
      if (spaceErr.message.includes('kurang dari 1GB')) {
        throw spaceErr;
      }
    }

    if (activeBuildCancellations.get(tag)) {
      throw new Error('Build dibatalkan oleh user');
    }

    await setStatus(`<blockquote>🔨 <b>PROSES MENGUNDUH ZIP</b>
━━━━━━━━━━━━━━━━━
ⓘ Bot sedang mengunduh zip anda, silakan tunggu sebentar hingga proses selesai dan akan lanjut ke proses berikutnya...
</blockquote>`);
    await downloadDocumentViaGram(chatId, zipMessageId, zipPath);
    await setStatus(`<blockquote>✅ <b>SUKSES MENGUNDUH ZIP</b>
━━━━━━━━━━━━━━━━━
ⓘ Bot sudah mengunduh zip anda, bot sedang mengunggah ke server private nted, <b>ZIP</b> kamu akan di tempat kan di tempat yang aman, dan otomatis menghapus sehingga tidak ada orang yang mengambil project kamu...
</blockquote>`);

    const info = tryReadPubspecName(zipPath);
    projectDisplay = info || 'terdeteksi';

    if (activeBuildCancellations.get(tag)) {
      throw new Error('Build dibatalkan oleh user');
    }

    await setStatus(`<blockquote>⏳ <b>MENGUNGGAH PROJECT</b>
━━━━━━━━━━━━━━━━━━━━
ᯤ <b>Project:</b> ${escapeHtml(projectDisplay)}
ᯤ <b>Status:</b> ⏳ Proses kompilasi
━━━━━━━━━━━━━━━━━━━━
☁️ Mengunggah project ke cloud...
</blockquote>`
    );

    const uploaded = await uploadZipAsReleaseAsset(zipPath, doc.file_name);
    releaseId = uploaded.releaseId;
    currentBuild.releaseId = releaseId;
    
    await setStatus(`<blockquote>✅ <b>MENGUNGGAH PROJECT</b>
━━━━━━━━━━━━━━━━━━
ᯤ <b>Project:</b> ${escapeHtml(projectDisplay)}
ᯤ <b>Status:</b> ✅ Successfully
━━━━━━━━━━━━━━━━━━
☁️ Success menggugah project ke cloud...
</blockquote>`);

    if (activeBuildCancellations.get(tag)) {
      throw new Error('Build dibatalkan oleh user');
    }
    
    await setStatus(`<blockquote>
 ⓘ <b>[ STATUS BUILD PROJECT ANDA ]</b>
━━━━━━━━━━━━━━━━━━━━
ᯤ <b>Project:</b> ${escapeHtml(projectDisplay)}
ᯤ <b>Status:</b> Kompilasi Source...
━━━━━━━━━━━━━━━━━━━━
🚀 Sedang memperoses project
</blockquote>`);

    const triggerTime = new Date();
    await triggerWorkflow({
      zip_url: uploaded.assetApiUrl,
      tag,
      build_type: session.buildType,
      only_analyze: session.onlyAnalyze ? 'true' : 'false',
    });

    await setStatus(
      `🔎 Mencari run yang baru saja dipicu...`
    );

    const run = await findTriggeredRun(triggerTime);
    if (!run) throw new Error('Tidak bisa menemukan run workflow yang baru dipicu');
    
    currentBuild.runId = run.id;
    currentBuild.status = 'running';

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    await setStatus(
      `<blockquote>ⓘ [ STATUS BUILD PROJECT ANDA ]\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `ᯤ Project: ${escapeHtml(projectDisplay)}\n` +
      `ᯤ Mode: ${session.buildType}\n` +
      `ᯤ Status: ⏳ Build sedang berjalan...\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `ⓘ [ KOMPILASI SEDANG BERLANGSUNG ]\n` +
      `${advancedProgressBar(0)}\n` +
      `Waktu: <code>${formatDuration(elapsed)}</code>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⏳ Proses kompilasi, tunggu sebentar...\n` +
      `</blockquote>`
    );

    const finished = await waitForRunCompletion(run.id, chatId, statusMsg.message_id, session.buildType, projectDisplay, startTime);

    if (activeBuildCancellations.get(tag)) {
      throw new Error('Build dibatalkan oleh user');
    }

    if (finished.conclusion !== 'success') {
      await setStatus(
        `❌ Build gagal (status: <code>${finished.conclusion}</code>)`,
        100
      );
      
      const fullLog = await getErrorLog(run.id);
      
      if (fullLog && fullLog.trim().length > 0) {
        await bot.sendMessage(chatId, '📋 <b>Mengirim log error...</b>', { parse_mode: 'HTML' });

        const logFile = tmpPath(`build_error_${tag}_${Date.now()}.txt`);
        fs.writeFileSync(logFile, fullLog, 'utf-8');

        try {
          await sendDocumentViaGram(chatId, logFile, `error-log-${tag}.txt`);
        } catch (errGram) {
          console.error('Gagal kirim log error via Gram:', errGram.message);
          try {
            await bot.sendDocument(chatId, logFile);
          } catch (errBot) {
            console.error('Gagal kirim log error via bot:', errBot.message);
            await debugErrorfile(chatId, fullLog);
          }
        } finally {
          fs.unlink(logFile, () => {});
        }
      }
      return;
    }

    if (session.onlyAnalyze) {
      await setStatus('📄 Build selesai, mengambil hasil analyze...');
      const analyzeText = await getAnalyzeResult(run.id);
      await sendAnalyzeResult(chatId, analyzeText, run.html_url);
      await setStatus('✅ Analyze selesai');
    } else {
      await setStatus('📦 Build sukses, mengunduh APK...');
      
      const artifactName = `flutter-${session.buildType}-${tag}`;
      const apkPath = await downloadArtifactApk(run.id, artifactName, tmpDir);
      
      const apkSizeMB = (fs.statSync(apkPath).size / 1024 / 1024).toFixed(2);
      const totalDuration = Math.floor((Date.now() - startTime) / 1000);
      
      await setStatus('📤 Sedang mengirimkan project apk kamu');
      
      try {
        await sendDocumentViaGram(
          chatId,
          apkPath,
          `
✅ SUCCESS BUILD PROJECT KAMU
 🔨 Project: app-${session.buildType}.apk

Silahkan instal apk kamu.`
        );
      } catch (err) {
        console.error('Gagal kirim APK via Gram:', err.message);
        try {
          await bot.sendDocument(chatId, apkPath);
        } catch (err2) {
          console.error('Gagal kirim APK via bot:', err2.message);
        }
      }

      const successMsg = `<blockquote>🎉 [ SUCCESS BUILD PROJECT ]\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `ᯤ Project: ${escapeHtml(projectDisplay)}\n` +
        `ᯤ Mode: ${session.buildType}\n` +
        `ᯤ Status: ✅ Success build project\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `ⓘ [ HASIL BUILD PROJECT KAMU ]\n` +
        `ᯤ Durasi: <code>${formatDuration(totalDuration)}</code>\n` +
        `ᯤ Size: <code>${apkSizeMB} MB</code>\n` +
        `ᯤ Status: ✅ <b>Sukses build</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🔨 Project sudah terbuild dengan aman\n` +
        `</blockquote>`;

      await setStatus(successMsg);
      
      const projectName = escapeHtml(projectDisplay);
      const username = from.username || 'unknown';
      
      if (currentBuild && currentBuild.channelNotifMsgId) {
        const successMsg = `
✅ <b>BUILD SELESAI</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${from.id}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(currentBuild.accessLevel)}
🕒 <b>Waktu:</b> ${formatDuration(totalDuration)}
🏗️ <b>Project:</b> <b>${projectName}</b>
📦 <b>Ukuran:</b> ${apkSizeMB} MB

${advancedProgressBar(100)}
━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();
        await bot.editMessageText(successMsg, {
          chat_id: config.NOTIF_CHANNEL_ID,
          message_id: currentBuild.channelNotifMsgId,
          parse_mode: 'HTML'
        }).catch(() => {});
      } else {
        sendNotificationToChannel(from.id, username, projectName, 'complete', currentBuild?.accessLevel).catch(() => {});
      }
      
      await backupUserData(from.id, username, from.first_name, { 
        event: 'build_complete',
        status: 'success',
        projectName,
        buildType: session.buildType,
        duration: totalDuration,
        apkSize: apkSizeMB
      });
      
      const backupFile = path.join(config.BACKUP_DIR, 'user.json');
      await sendBackupToOwner(from.id, username, backupFile);
    }
  } catch (err) {
    console.error('build flow error:', err.message);
    
    if (err.message === 'Build dibatalkan oleh user') {
      await setStatus('⏹️ <b>Build dibatalkan oleh user</b>');
      return;
    }

    if (err.code === 'ENOSPC') {
      console.error('[ENOSPC] Disk penuh! Jalankan aggressive cleanup...');
      
      try {
        cleanupStaleTempFiles();
        
        const tmpRoot = config.DirFile;
        if (fs.existsSync(tmpRoot)) {
          const tenMinMs = 10 * 60 * 1000;
          for (const name of fs.readdirSync(tmpRoot)) {
            const fullPath = path.join(tmpRoot, name);
            try {
              const stat = fs.statSync(fullPath);
              if (Date.now() - stat.mtimeMs > tenMinMs) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`[ENOSPC] Force cleaned: ${name}`);
              }
            } catch (e) {}
          }
        }
        
        await setStatus(
          '⚠️ <b>Disk server penuh, sedang cleanup...</b>\n\n' +
          'Temporary files sedang dibersihkan. Silakan coba build lagi dalam 2 menit.'
        );
      } catch (cleanErr) {
        console.error('[ENOSPC] Cleanup failed:', cleanErr.message);
        await setStatus(
          '❌ <b>Disk server penuh (ENOSPC)</b>\n\n' +
          'Penyimpanan server sudah habis dan cleanup otomatis gagal. ' +
          'Owner bot perlu bersihin disk server secara manual. ' +
          'Coba build lagi dalam beberapa menit.'
        );
      }
      
      if (!isOwner(chatId)) {
        bot.sendMessage(
          config.OWNER_CHAT_ID,
          `🛑 <b>ENOSPC Alert</b>\n` +
          `Chat ID: <code>${chatId}</code>\n` +
          `Disk server penuh! Automatic cleanup sedang berjalan.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }
    
    const errorMsg = escapeHtml(err.response?.data?.message || err.message);
    await setStatus(`❌ Gagal: ${errorMsg}`);
    
    const username = from.username || 'unknown';
    const projectName = projectDisplay || '-';
    
    if (currentBuild && currentBuild.channelNotifMsgId) {
      const elapsedErr = Math.floor((Date.now() - currentBuild.startedAt) / 1000);
      const errorMsg = `
❌ <b>BUILD GAGAL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User ID:</b> <code>${from.id}</code>
📝 <b>Username:</b> @${username}
🔑 <b>Akses:</b> ${accessLevelLabel(currentBuild.accessLevel)}
🕒 <b>Waktu:</b> ${formatDuration(elapsedErr)}
🏗️ <b>Project:</b> <b>${projectName}</b>

${advancedProgressBar(currentBuild.progress || 0)}
━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();
      await bot.editMessageText(errorMsg, {
        chat_id: config.NOTIF_CHANNEL_ID,
        message_id: currentBuild.channelNotifMsgId,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      sendNotificationToChannel(from.id, username, projectName, 'error', currentBuild?.accessLevel).catch(() => {});
    }
    
    await backupUserData(from.id, username, from.first_name, { 
      event: 'build_failed',
      status: 'error',
      projectName: projectDisplay,
      error: errorMsg,
      buildType: session.buildType
    });
  } finally {
    if (releaseId) {
      await deleteRelease(releaseId).catch((e) => console.error('cleanup release gagal:', e.message));
    }
    
    try {
      if (fs.existsSync(tmpDir)) {
        const size = calculateDirSize(tmpDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(`[BUILD] Cleaned tmpDir: ${(size/1024/1024).toFixed(2)}MB`);
      }
    } catch (e) {
      console.error('Gagal hapus tmpDir:', e.message);
      setTimeout(() => {
        try {
          if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            console.log('[BUILD] tmpDir removed on retry');
          }
        } catch (e2) {
          console.error('tmpDir cleanup retry gagal:', e2.message);
        }
      }, 1000);
    }
    
    activeBuildCancellations.delete(tag);
    currentBuild = null;
    cleanupStaleTempFiles();
    processQueue().catch(err => console.error('[QUEUE] Error processing queue:', err.message));
  }
}

async function waitForRunCompletion(runId, chatId, messageId, buildType, projectDisplay, startTime) {
  const deadline = Date.now() + config.POLL_TIMEOUT_MS;
  const pollStartTime = Date.now(); 
  let lastUpdate = Date.now();
  let previousStatus = '';

  while (Date.now() < deadline) {
    const res = await gh.get(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/runs/${runId}`);
    
    if (res.data.status === 'completed') {
      return res.data;
    }
    if (Date.now() - lastUpdate > 15000) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const buildElapsedMs = Date.now() - pollStartTime;
      const progress = Math.min(95, Math.floor((buildElapsedMs / config.ESTIMATED_BUILD_MS) * 95));
      
      const updateMsg = 
        `<blockquote>ⓘ [ STATUS BUILD PROJECT ANDA ]\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `ᯤ Project: ${escapeHtml(projectDisplay)}\n` +
        `ᯤ Mode: ${buildType}\n` +
        `ᯤ Status: ⏳ Build sedang berjalan...\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `ⓘ [ KOMPILASI SEDANG BERLANGSUNG ]\n` +
        `${advancedProgressBar(progress)}\n` +
        `Waktu: <code>${formatDuration(elapsed)}</code>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⏳ Proses kompilasi, tunggu sebentar...\n` +
        `</blockquote>`;

      try {
        await bot.editMessageText(updateMsg, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          ...buildStatusKeyboard()
        });
        
        if (currentBuild && currentBuild.channelNotifMsgId) {
          await updateBuildNotification(
            currentBuild.channelNotifMsgId,
            currentBuild.userId,
            currentBuild.username,
            projectDisplay,
            progress,
            elapsed,
            currentBuild.accessLevel
          ).catch(() => {});
        }
        
        lastUpdate = Date.now();
      } catch (e) {
        console.log('[BUILD] Skip update progress');
      }
    }

    await sleep(config.POLL_INTERVAL_MS);
  }

  throw new Error('Timeout menunggu build selesai.');
}

async function sendAnalyzeResult(chatId, text, runUrl) {
  const body = text && text.trim() ? text.trim() : '(tidak ada output)';
  const header = `📋 <b>Hasil Analyze</b>\n🔗 ${runUrl}\n\n`;
  
  if (header.length + body.length + 20 < 4000) {
    await bot.sendMessage(chatId, `${header}<pre>${escapeHtml(body).slice(0, 3500)}</pre>`, { parse_mode: 'HTML' });
  } else {
    const tmpFile = tmpPath(`analyze-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, body, 'utf-8');
    await bot.sendMessage(chatId, header, { parse_mode: 'HTML' });
    await sendDocumentViaGram(chatId, tmpFile, 'Hasil analyze (file lengkap)');
    fs.unlinkSync(tmpFile);
  }
}

function tryReadPubspecName(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntries().find((e) => {
      const parts = e.entryName.split('/').filter(Boolean);
      return parts[parts.length - 1] === 'pubspec.yaml' && parts.length <= 2;
    });
    if (!entry) return null;
    const parsed = yaml.load(entry.getData().toString('utf8')) || {};
    return parsed.name || null;
  } catch {
    return null;
  }
}

async function uploadZipAsReleaseAsset(zipPath, fileName) {
  const tagName = `source-${Date.now()}`;

  const release = await gh.post(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases`, {
    tag_name: tagName,
    name: `Auto source upload ${tagName}`,
    body: 'Source zip diunggah otomatis oleh bot untuk keperluan build. Dihapus otomatis setelah build selesai.',
    draft: false,
    prerelease: true,
    target_commitish: config.GITHUB_BRANCH,
  });

  const uploadUrl = release.data.upload_url.replace('{?name,label}', '');
  const stats = fs.statSync(zipPath);
  const fileStream = fs.createReadStream(zipPath, { highWaterMark: 1024 * 1024 });
  
  let uploaded = 0;
  let lastProgress = 0;
  
  fileStream.on('data', (chunk) => {
    uploaded += chunk.length;
    const progress = Math.floor((uploaded / stats.size) * 100);
    if (progress >= lastProgress + 10) {
      lastProgress = progress;
      console.log(`[GITHUB] Upload: ${progress}% (${(uploaded/1024/1024).toFixed(1)}/${(stats.size/1024/1024).toFixed(1)} MB)`);
    }
  });

  try {
    const asset = await axios.post(uploadUrl, fileStream, {
      params: { name: fileName },
      headers: {
        Authorization: `token ${config.GITHUB_TOKEN}`,
        'Content-Type': 'application/zip',
        'Content-Length': stats.size,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
    });

    return { assetApiUrl: asset.data.url, releaseId: release.data.id };
  } catch (err) {
    fileStream.destroy();
    throw err;
  }
}

async function deleteRelease(releaseId) {
  try {
    await gh.delete(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/${releaseId}`);
    console.log(`[GITHUB] Release ${releaseId} deleted`);
  } catch (err) {
    console.error(`[GITHUB] Failed to delete release ${releaseId}:`, err.message);
  }
}

async function cleanupOldReleases(maxAge = 2 * 60 * 60 * 1000) {
  try {
    console.log('[SERVER] Checking for old releases to cleanup...');
    const res = await gh.get(
      `/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases`,
      { params: { per_page: 100 } }
    );
    
    const now = Date.now();
    let cleaned = 0;
    
    for (const release of res.data) {
      if (!release.tag_name.startsWith('source-')) continue;
      
      const createdAt = new Date(release.created_at).getTime();
      if (now - createdAt > maxAge) {
        try {
          await deleteRelease(release.id);
          cleaned++;
        } catch (err) {
          console.warn(`[GITHUB] Failed to delete old release ${release.id}:`, err.message);
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`[GITHUB] ✅ Cleaned ${cleaned} old releases`);
    }
  } catch (err) {
    console.warn('[GITHUB] Cleanup releases error:', err.message);
  }
}

async function triggerWorkflow(inputs) {
  await gh.post(
    `/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/workflows/${config.GITHUB_WORKFLOW_FILE}/dispatches`,
    { ref: config.GITHUB_BRANCH, inputs }
  );
}

async function findTriggeredRun(afterDate, maxWaitMs = 30000, stepMs = 2000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await gh.get(
      `/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/workflows/${config.GITHUB_WORKFLOW_FILE}/runs`,
      { params: { event: 'workflow_dispatch', per_page: 5 } }
    );
    const found = res.data.workflow_runs.find((r) => new Date(r.created_at) >= new Date(afterDate.getTime() - 5000));
    if (found) return found;
    await sleep(stepMs);
  }
  return null;
}

async function downloadArtifactApk(runId, artifactName, tmpDir) {
  const res = await gh.get(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/runs/${runId}/artifacts`);
  const artifact = res.data.artifacts.find((a) => a.name === artifactName) || res.data.artifacts[0];
  if (!artifact) throw new Error('Artifact APK tidak ditemukan di run ini.');

  const zipBuffer = await downloadBinary(
    `${GITHUB_API}/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
    { Authorization: `token ${config.GITHUB_TOKEN}` }
  );

  const zip = new AdmZip(zipBuffer);
  const apkEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.apk'));
  if (!apkEntry) throw new Error('File .apk tidak ditemukan di dalam artifact.');

  const apkPath = path.join(tmpDir, path.basename(apkEntry.entryName));
  fs.writeFileSync(apkPath, apkEntry.getData());
  return apkPath;
}

async function getAnalyzeResult(runId) {
  const jobsRes = await gh.get(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/runs/${runId}/jobs`);
  const job = jobsRes.data.jobs[0];
  if (!job) return '(job tidak ditemukan)';

  const logBuffer = await downloadBinary(
    `${GITHUB_API}/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/jobs/${job.id}/logs`,
    { Authorization: `token ${config.GITHUB_TOKEN}` }
  );
  const logText = logBuffer.toString('utf8');

  const start = logText.indexOf('[RESULT_ANALYZE]');
  const end = logText.indexOf('[END_RESULT_ANALYZE]');
  if (start === -1 || end === -1) return '(tidak ditemukan blok hasil analyze di log)';

  return logText
    .slice(start + '[RESULT_ANALYZE]'.length, end)
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/gm, '')
    .trim();
}
async function getErrorLog(runId) {
  try {
    const jobsRes = await gh.get(`/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/runs/${runId}/jobs`);
    if (!jobsRes.data.jobs || jobsRes.data.jobs.length === 0) {
      return 'Tidak ada job yang ditemukan';
    }

    const job = jobsRes.data.jobs[0];
    const logBuffer = await downloadBinary(
      `${GITHUB_API}/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/actions/jobs/${job.id}/logs`,
      { Authorization: `token ${config.GITHUB_TOKEN}` }
    );
    const fullLog = logBuffer.toString('utf8');
    const lines = fullLog.split('\n');
    const errorLines = [];
    let foundError = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('ERROR') || line.includes('error') || line.includes('failed') || line.includes('FAILED') || line.includes('BUILD FAILED')) {
        foundError = true;
        const start = Math.max(0, i - 3);
        const end = Math.min(lines.length, i + 4);
        for (let j = start; j < end; j++) {
          if (!errorLines.includes(lines[j])) {
            errorLines.push(lines[j]);
          }
        }
      }
    }

    if (errorLines.length === 0) {
      errorLines.push(...lines.slice(-50));
    }

    const result = `╔══════════════════════════════════════╗\n` +
      `║   BUILD ERROR LOG REPORT            ║\n` +
      `╚══════════════════════════════════════╝\n\n` +
      `Generated: ${new Date().toLocaleString('id-ID')}\n` +
      `Run ID: ${runId}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `ERROR SECTIONS:\n\n` +
      `${errorLines.join('\n')}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `FULL LOG LENGTH: ${fullLog.length} characters\n` +
      `TOTAL JOBS: ${jobsRes.data.jobs.length}\n\n` +
      `Full log available at GitHub Actions dashboard.`;

    return result;
  } catch (err) {
    console.error('Error getting error log:', err.message);
    return `Error retrieving log: ${err.message}`;
  }
}

async function downloadBinary(url, authHeaders) {
  const first = await axios.get(url, {
    headers: authHeaders,
    responseType: 'arraybuffer',
    maxRedirects: 0,
    validateStatus: () => true,
  });

  if (first.status >= 300 && first.status < 400 && first.headers.location) {
    const second = await axios.get(first.headers.location, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    if (second.status >= 200 && second.status < 300) return second.data;
    throw new Error(`Download redirect gagal, status ${second.status}`);
  }

  if (first.status >= 200 && first.status < 300) return first.data;
  throw new Error(`Download gagal, status ${first.status}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

console.log('🤖 Flutter Build Bot berjalan...');

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
