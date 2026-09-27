const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const { Button } = require('telegram/tl/custom/button');

const config = require('./config');

const SESSION_FILE = path.join(__dirname, '.gram_session');

function tmpPath(filename) {
  return path.join(config.DirFile, filename);
}

function loadSessionString() {
  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    return data || '';
  } catch {
    return '';
  }
}

function saveSessionString(str) {
  try {
    fs.writeFileSync(SESSION_FILE, str);
  } catch (err) {
    console.error('❌ Gagal menyimpan session GramJS:', err.message);
  }
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    saveSessionString('');
    console.log('🧹 Session cleared');
  } catch (err) {
    console.error('❌ Gagal clear session:', err.message);
  }
}

const stringSession = new StringSession(loadSessionString());

const client = new TelegramClient(stringSession, config.ApiID, config.ApiHash, {
  connectionRetries: 5,
  retryDelay: 3000,
  autoReconnect: true,
  floodSleepThreshold: 60,
  deviceModel: 'Bot',
  systemVersion: '1.0',
  appVersion: '1.0',
});

let startPromise = null;
let isStarting = false;

async function ensureStarted() {
  if (isStarting) {
    await startPromise;
    return client;
  }

  if (client.connected && client.authorized) {
    return client;
  }

  if (!startPromise) {
    isStarting = true;
    
    startPromise = client
      .start({
        botAuthToken: config.TokenBot,
        onError: (err) => {
          console.error('❌ GramJS error:', err.message);
          if (err.message.includes('AUTH_KEY_UNREGISTERED') || 
              err.message.includes('SESSION_REVOKED') ||
              err.message.includes('SESSION_EXPIRED')) {
            console.log('⚠️ Session invalid, clearing...');
            clearSession();
            startPromise = null;
          }
        },
      })
      .then(async () => {
        saveSessionString(client.session.save());
        try {
          const me = await client.getMe();
          console.log(`✅ GramJS (MTProto) siap — Bot: @${me.username || me.id}`);
          console.log(`✅ Support file up to 2GB aktif`);
          isStarting = false;
          return client;
        } catch (err) {
          console.error('❌ Failed to verify bot:', err.message);
          isStarting = false;
          throw err;
        }
      })
      .catch(async (err) => {
        console.error('❌ Gagal start GramJS:', err.message);
        isStarting = false;
        startPromise = null;
        
        if (err.message.includes('AUTH_KEY_UNREGISTERED') || 
            err.message.includes('SESSION_REVOKED')) {
          clearSession();
          console.log('🔄 Retry start with new session...');
          return ensureStarted();
        }
        throw err;
      });
  }
  
  return startPromise;
}

async function downloadDocumentViaGram(chatId, messageId, destPath) {
  await ensureStarted();
  
  if (!destPath) {
    destPath = tmpPath(`${chatId}_${Date.now()}.zip`);
    console.log(`📝 Auto-generated temp path: ${destPath}`);
  }
  
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  try {
    console.log(`⬇️ Download from chat ${chatId}, message ${messageId}`);
    
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    const message = messages[0];
    
    if (!message || !message.document) {
      throw new Error('Pesan/file tidak ditemukan lewat MTProto');
    }
    
    const fileSizeMB = (message.document.size / 1024 / 1024).toFixed(2);
    console.log(`📦 File size: ${fileSizeMB} MB`);
    
    let lastProgress = 0;
    const buffer = await client.downloadMedia(message, {
      progressCallback: (downloaded, total) => {
        const percent = Math.floor((downloaded / total) * 100);
        if (percent >= lastProgress + 10) {
          lastProgress = percent;
          console.log(`⬇️ Download: ${percent}% (${(downloaded/1024/1024).toFixed(1)}/${(total/1024/1024).toFixed(1)} MB)`);
        }
      }
    });
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Buffer download kosong');
    }
    
    fs.writeFileSync(destPath, buffer);
    console.log(`✅ File saved to ${destPath}`);
    
    return destPath;
  } catch (error) {
    console.error('❌ Download failed:', error.message);
    throw new Error(`Download gagal: ${error.message}`);
  }
}

async function sendDocumentViaGram(chatId, filePath, caption = '') {
  await ensureStarted();
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File tidak ditemukan: ${filePath}`);
  }
  
  const stats = fs.statSync(filePath);
  const fileSizeMB = stats.size / 1024 / 1024;
  const fileName = path.basename(filePath);
  
  console.log(`📤 Sending: ${fileName} (${fileSizeMB.toFixed(2)} MB) to ${chatId}`);
  
  if (stats.size > 2 * 1024 * 1024 * 1024) {
    throw new Error(`❌ File terlalu besar: ${fileSizeMB.toFixed(2)} MB (max 2000 MB)`);
  }
  
  const methods = [
    { name: 'Direct Send File', fn: sendDirect },
    { name: 'Manual Upload', fn: sendManualUpload },
    { name: 'InputMedia Document', fn: sendInputMedia },
    { name: 'Stream Upload', fn: sendStreamUpload },
  ];
  
  let lastError = null;
  
  for (const method of methods) {
    try {
      console.log(`🔄 Trying method: ${method.name}...`);
      const result = await method.fn(chatId, filePath, fileName, caption);
      console.log(`✅ Success with: ${method.name}`);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ ${method.name} failed:`, error.message);
      
      if (fileSizeMB < 50 && method.name === 'Direct Send File') {
        console.log('🔄 File kecil, mencoba metode lain...');
        continue;
      }
    }
  }
  
  throw new Error(`❌ Gagal kirim file: ${lastError?.message || 'Unknown error'}`);
}

async function sendDirect(chatId, filePath, fileName, caption) {
  const stats = fs.statSync(filePath);
  let uploaded = 0;
  let lastProgress = 0;
  
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  
  stream.on('data', (chunk) => {
    uploaded += chunk.length;
    const progress = Math.floor((uploaded / stats.size) * 100);
    if (progress >= lastProgress + 10) {
      lastProgress = progress;
      console.log(`📤 Direct upload: ${progress}%`);
    }
  });
  
  const result = await client.sendFile(chatId, {
    file: filePath,
    caption: caption || fileName,
    forceDocument: true,
  });
  
  stream.destroy();
  return result;
}

async function sendManualUpload(chatId, filePath, fileName, caption) {
  const stats = fs.statSync(filePath);
  let uploaded = 0;
  let lastProgress = 0;
  
  const fileObj = {
    read: async (size) => {
      return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { 
          start: uploaded,
          end: Math.min(uploaded + size - 1, stats.size - 1),
          highWaterMark: 128 * 1024
        });
        
        const chunks = [];
        stream.on('data', (chunk) => {
          chunks.push(chunk);
          uploaded += chunk.length;
          const progress = Math.floor((uploaded / stats.size) * 100);
          if (progress >= lastProgress + 10) {
            lastProgress = progress;
            console.log(`📤 Manual upload: ${progress}%`);
          }
        });
        
        stream.on('end', () => {
          if (chunks.length === 0) {
            resolve(null);
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
        
        stream.on('error', reject);
      });
    },
    size: stats.size,
    name: fileName,
  };
  
  const uploadedFile = await client.uploadFile({
    file: fileObj,
    workers: 4,
  });
  
  const result = await client.sendMessage(chatId, {
    message: caption || fileName,
    file: uploadedFile,
    forceDocument: true,
    attributes: [
      new Api.DocumentAttributeFilename({ fileName: fileName })
    ]
  });
  
  return result;
}

async function sendInputMedia(chatId, filePath, fileName, caption) {
  const stats = fs.statSync(filePath);
  let uploaded = 0;
  let lastProgress = 0;
  
  const fileObj = {
    read: async (size) => {
      return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { 
          start: uploaded,
          end: Math.min(uploaded + size - 1, stats.size - 1),
          highWaterMark: 128 * 1024
        });
        
        const chunks = [];
        stream.on('data', (chunk) => {
          chunks.push(chunk);
          uploaded += chunk.length;
          const progress = Math.floor((uploaded / stats.size) * 100);
          if (progress >= lastProgress + 10) {
            lastProgress = progress;
            console.log(`📤 InputMedia upload: ${progress}%`);
          }
        });
        
        stream.on('end', () => {
          if (chunks.length === 0) {
            resolve(null);
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
        
        stream.on('error', reject);
      });
    },
    size: stats.size,
    name: fileName,
  };
  
  const uploadedFile = await client.uploadFile({
    file: fileObj,
    workers: 4,
  });
  
  const result = await client.invoke(
    new Api.messages.SendMedia({
      peer: chatId,
      media: new Api.InputMediaUploadedDocument({
        file: uploadedFile,
        mimeType: getMimeType(fileName),
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: fileName }),
        ],
        forceFile: true,
      }),
      message: caption || fileName,
      randomId: BigInt(Date.now() * 1000),
    })
  );
  
  return result;
}

async function sendStreamUpload(chatId, filePath, fileName, caption) {
  const stats = fs.statSync(filePath);
  const CHUNK_SIZE = 512 * 1024;
  
  console.log(`📤 Streaming upload: ${(stats.size/1024/1024).toFixed(2)} MB`);
  
  let uploaded = 0;
  let lastProgress = 0;
  let stream = null;
  let currentChunk = null;
  let chunkPos = 0;
  
  const uploadedFile = await client.uploadFile({
    file: {
      read: async (size) => {
        try {
          if (!stream) {
            stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
          }
          if (!currentChunk) {
            currentChunk = stream.read(size);
          }
          
          if (currentChunk) {
            const toSend = currentChunk.slice(chunkPos, chunkPos + size);
            chunkPos += toSend.length;
            
            if (chunkPos >= currentChunk.length) {
              currentChunk = null;
              chunkPos = 0;
            }
            
            uploaded += toSend.length;
            const progress = Math.floor((uploaded / stats.size) * 100);
            if (progress >= lastProgress + 10) {
              lastProgress = progress;
              console.log(`📤 Stream upload: ${progress}%`);
            }
            
            return toSend;
          } else {
            if (uploaded >= stats.size) {
              stream.destroy();
              return null;
            }
            
            return new Promise((resolve, reject) => {
              stream.once('readable', () => {
                currentChunk = stream.read(size);
                if (currentChunk) {
                  const toSend = currentChunk.slice(0, size);
                  chunkPos = toSend.length;
                  
                  uploaded += toSend.length;
                  const progress = Math.floor((uploaded / stats.size) * 100);
                  if (progress >= lastProgress + 10) {
                    lastProgress = progress;
                    console.log(`📤 Stream upload: ${progress}%`);
                  }
                  
                  resolve(toSend);
                } else {
                  resolve(null);
                }
              });
              
              stream.once('end', () => resolve(null));
              stream.once('error', reject);
            });
          }
        } catch (error) {
          if (stream) stream.destroy();
          throw error;
        }
      },
      size: stats.size,
      name: fileName,
    },
    workers: 4,
  });
  
  const result = await client.sendMessage(chatId, {
    message: caption || fileName,
    file: uploadedFile,
    forceDocument: true,
    attributes: [
      new Api.DocumentAttributeFilename({ fileName: fileName })
    ]
  });
  
  return result;
}

async function sendDocumentWithRetry(chatId, filePath, caption = '', maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt}/${maxRetries}...`);
      const result = await sendDocumentViaGram(chatId, filePath, caption);
      console.log(`✅ Success on attempt ${attempt}`);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        let waitTime = attempt * 5000;
        
        if (error.message.includes('ENOSPC') || error.message.includes('No space left')) {
          waitTime = attempt * 15000;
          console.log(`💾 Disk penuh detected, waiting longer...`);
        }
        
        console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
        await sleep(waitTime);
        
        if (!client.connected) {
          console.log('🔄 Reconnecting...');
          try {
            await client.connect();
          } catch (connErr) {
            console.warn('Reconnect failed:', connErr.message);
          }
        }
      }
    }
  }
  
  throw new Error(`❌ Failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

async function sendDocumentAsFile(chatId, filePath, caption = '') {
  await ensureStarted();
  
  const stats = fs.statSync(filePath);
  const fileSizeMB = stats.size / 1024 / 1024;
  const fileName = path.basename(filePath);
  
  console.log(`📤 Sending as file: ${fileName} (${fileSizeMB.toFixed(2)} MB)`);
  
  if (stats.size > 2 * 1024 * 1024 * 1024) {
    throw new Error(`File terlalu besar: ${fileSizeMB.toFixed(2)} MB (max 2000 MB)`);
  }
  
  try {
    let uploaded = 0;
    let lastProgress = 0;
    
    const fileObj = {
      read: async (size) => {
        return new Promise((resolve, reject) => {
          const stream = fs.createReadStream(filePath, { 
            start: uploaded,
            end: Math.min(uploaded + size - 1, stats.size - 1),
            highWaterMark: 128 * 1024
          });
          
          const chunks = [];
          stream.on('data', (chunk) => {
            chunks.push(chunk);
            uploaded += chunk.length;
            const progress = Math.floor((uploaded / stats.size) * 100);
            if (progress >= lastProgress + 10) {
              lastProgress = progress;
              console.log(`📤 Upload as file: ${progress}%`);
            }
          });
          
          stream.on('end', () => {
            if (chunks.length === 0) {
              resolve(null);
            } else {
              resolve(Buffer.concat(chunks));
            }
          });
          
          stream.on('error', reject);
        });
      },
      size: stats.size,
      name: fileName,
    };
    
    const uploadedFile = await client.uploadFile({
      file: fileObj,
      workers: 4,
    });
    
    const result = await client.sendMessage(chatId, {
      message: caption || fileName,
      file: uploadedFile,
      forceDocument: true,
      attributes: [
        new Api.DocumentAttributeFilename({ fileName: fileName })
      ]
    });
    
    console.log(`✅ File sent successfully`);
    return result;
  } catch (error) {
    console.error('❌ Failed to send as file:', error.message);
    throw error;
  }
}

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = {
    '.apk': 'application/vnd.android.package-archive',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkGramHealth() {
  try {
    await ensureStarted();
    const me = await client.getMe();
    return { 
      status: 'ok', 
      bot: me.username || me.id, 
      connected: client.connected,
      authorized: client.authorized
    };
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    return { status: 'error', error: error.message };
  }
}

module.exports = {
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
  Button,
};