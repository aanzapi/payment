require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const archiver = require('archiver');
const FormData = require('form-data');
const cron = require('node-cron');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const RUMAHOTP_API_KEY = 'rk-dev-sol08R6qixrUv2MU4jfSzaLostotmwgV';
const RUMAHOTP_BASE_URL = 'https://www.rumahotp.io/api/v2';
const OTP_ADMIN_FEE = 200

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILES = {
  users: 'users.json',
  invoices: 'invoices.json',
  transactions: 'transactions.json',
  withdrawals: 'withdrawals.json',
  apiKeys: 'apikeys.json',
  settings: 'settings.json',
  stats: 'stats.json',
  otpOrders: 'otp_orders.json',
  notifications: 'notifications.json'
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

for (const [key, filename] of Object.entries(DB_FILES)) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify([], null, 2));
  }
}

async function readDB(collection) {
  try {
    const filepath = path.join(DATA_DIR, DB_FILES[collection]);
    const data = await fsPromises.readFile(filepath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${collection}:`, error);
    return [];
  }
}

async function writeDB(collection, data) {
  try {
    const filepath = path.join(DATA_DIR, DB_FILES[collection]);
    await fsPromises.writeFile(filepath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${collection}:`, error);
    return false;
  }
}

async function findOne(collection, query) {
  const data = await readDB(collection);
  return data.find(item => {
    for (const [key, value] of Object.entries(query)) {
      if (item[key] !== value) return false;
    }
    return true;
  });
}

async function find(collection, query = {}) {
  const data = await readDB(collection);
  if (Object.keys(query).length === 0) return data;
  return data.filter(item => {
    for (const [key, value] of Object.entries(query)) {
      if (item[key] !== value) return false;
    }
    return true;
  });
}

async function findById(collection, id) {
  const data = await readDB(collection);
  return data.find(item => item._id === id);
}

async function insertOne(collection, document) {
  const data = await readDB(collection);
  data.push(document);
  await writeDB(collection, data);
  return document;
}

async function updateOne(collection, query, update, options = {}) {
  const data = await readDB(collection);
  let updated = false;
  for (let i = 0; i < data.length; i++) {
    let match = true;
    for (const [key, value] of Object.entries(query)) {
      if (data[i][key] !== value) {
        match = false;
        break;
      }
    }
    if (match) {
      if (update.$set) {
        Object.assign(data[i], update.$set);
      }
      if (update.$inc) {
        for (const [key, value] of Object.entries(update.$inc)) {
          data[i][key] = (data[i][key] || 0) + value;
        }
      }
      updated = true;
      break;
    }
  }
  if (updated || options.upsert) {
    await writeDB(collection, data);
    return { modifiedCount: updated ? 1 : 0 };
  }
  return { modifiedCount: 0 };
}

async function updateById(collection, id, update) {
  const data = await readDB(collection);
  for (let i = 0; i < data.length; i++) {
    if (data[i]._id === id) {
      if (update.$set) {
        Object.assign(data[i], update.$set);
      }
      if (update.$inc) {
        for (const [key, value] of Object.entries(update.$inc)) {
          data[i][key] = (data[i][key] || 0) + value;
        }
      }
      await writeDB(collection, data);
      return true;
    }
  }
  return false;
}

async function deleteOne(collection, query) {
  const data = await readDB(collection);
  let deleted = false;
  for (let i = 0; i < data.length; i++) {
    let match = true;
    for (const [key, value] of Object.entries(query)) {
      if (data[i][key] !== value) {
        match = false;
        break;
      }
    }
    if (match) {
      data.splice(i, 1);
      deleted = true;
      break;
    }
  }
  if (deleted) {
    await writeDB(collection, data);
    return { deletedCount: 1 };
  }
  return { deletedCount: 0 };
}

async function deleteMany(collection, query) {
  const data = await readDB(collection);
  let deletedCount = 0;
  if (Object.keys(query).length === 0) {
    deletedCount = data.length;
    await writeDB(collection, []);
  } else {
    for (let i = data.length - 1; i >= 0; i--) {
      let match = true;
      for (const [key, value] of Object.entries(query)) {
        if (data[i][key] !== value) {
          match = false;
          break;
        }
      }
      if (match) {
        data.splice(i, 1);
        deletedCount++;
      }
    }
    await writeDB(collection, data);
  }
  return { deletedCount };
}

async function countDocuments(collection, query = {}) {
  const data = await readDB(collection);
  if (Object.keys(query).length === 0) return data.length;
  return data.filter(item => {
    for (const [key, value] of Object.entries(query)) {
      if (item[key] !== value) return false;
    }
    return true;
  }).length;
}

async function getNotifications(userId = null) {
  const notifs = await readDB('notifications');
  if (userId) {
    return notifs.filter(n => n.userId === userId || n.target === 'all').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return notifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveNotification(notifData) {
  const notifs = await readDB('notifications');
  notifs.push(notifData);
  await writeDB('notifications', notifs);
  return notifData;
}

async function updateNotification(notifId, updateData) {
  const notifs = await readDB('notifications');
  const index = notifs.findIndex(n => n._id === notifId);
  if (index !== -1) {
    Object.assign(notifs[index], updateData);
    await writeDB('notifications', notifs);
    return true;
  }
  return false;
}

async function deleteNotification(notifId) {
  const notifs = await readDB('notifications');
  const filtered = notifs.filter(n => n._id !== notifId);
  await writeDB('notifications', filtered);
  return true;
}

async function markNotificationAsSeen(notifId, userId) {
  const notifs = await readDB('notifications');
  const index = notifs.findIndex(n => n._id === notifId);
  if (index !== -1) {
    if (!notifs[index].seenBy) notifs[index].seenBy = [];
    if (!notifs[index].seenBy.includes(userId)) {
      notifs[index].seenBy.push(userId);
      await writeDB('notifications', notifs);
    }
    return true;
  }
  return false;
}

async function getOTPOrders(userId = null) {
  const orders = await readDB('otpOrders');
  if (userId) {
    return orders.filter(o => o.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveOTPOrder(orderData) {
  const orders = await readDB('otpOrders');
  orders.push(orderData);
  await writeDB('otpOrders', orders);
  return orderData;
}

async function updateOTPOrder(orderId, updateData) {
  const orders = await readDB('otpOrders');
  const index = orders.findIndex(o => o._id === orderId);
  if (index !== -1) {
    Object.assign(orders[index], updateData);
    await writeDB('otpOrders', orders);
    return true;
  }
  return false;
}

// ===================== RUMAHOTP BALANCE =====================
async function getRumahOTPBalance() {
  try {
    console.log('[DEBUG] Fetching RumahOTP balance...');
    const response = await axios.get('https://www.rumahotp.io/api/v1/user/balance', {
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Balance response:', response.data);
    return response.data;
  } catch (error) {
    console.error('[ERROR] Get balance failed:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
}

async function getRumahOTPServices() {
  try {
    console.log('[DEBUG] Fetching services from RumahOTP...');
    const response = await axios.get(`${RUMAHOTP_BASE_URL}/services`, {
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Services response status:', response.status);
    console.log('[DEBUG] Services success:', response.data.success);
    if (response.data.data) {
      console.log('[DEBUG] Services count:', response.data.data.length);
    }
    return response.data;
  } catch (error) {
    console.error('[ERROR] Get services failed:');
    console.error('Status:', error.response?.status);
    console.error('Message:', error.response?.data?.error?.message || error.message);
    return { success: false, data: [], error: error.response?.data?.error?.message || error.message };
  }
}

async function getRumahOTPCountries(serviceId) {
  try {
    console.log(`[DEBUG] Fetching countries for service ${serviceId}...`);
    const response = await axios.get(`${RUMAHOTP_BASE_URL}/countries?service_id=${serviceId}`, {
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Countries response success:', response.data.success);
    return response.data;
  } catch (error) {
    console.error('[ERROR] Get countries failed:', error.response?.data || error.message);
    return { success: false, data: [] };
  }
}

async function getRumahOTPOperators(countryName, providerId) {
  try {
    console.log(`[DEBUG] Fetching operators for ${countryName} with provider ${providerId}...`);
    const response = await axios.get(`${RUMAHOTP_BASE_URL}/operators?country=${encodeURIComponent(countryName)}&provider_id=${providerId}`, {
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Operators response success:', response.data.success);
    return response.data;
  } catch (error) {
    console.error('[ERROR] Get operators failed:', error.response?.data || error.message);
    return { success: false, data: [] };
  }
}

async function orderRumahOTPNumber(numberId, providerId, operatorId) {
  try {
    console.log(`[DEBUG] Ordering number - numberId:${numberId}, providerId:${providerId}, operatorId:${operatorId}`);
    const response = await axios.get(`${RUMAHOTP_BASE_URL}/orders`, {
      params: {
        number_id: parseInt(numberId),
        provider_id: parseInt(providerId),
        operator_id: parseInt(operatorId)
      },
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Order response status:', response.status);
    console.log('[DEBUG] Order response data:', JSON.stringify(response.data).substring(0, 200));
    return response.data;
  } catch (error) {
    console.error('[ERROR] Order number failed:');
    console.error('Status:', error.response?.status);
    console.error('Message:', error.response?.data?.error?.message || error.message);
    return { success: false, error: error.response?.data?.error?.message || 'Gagal memesan nomor' };
  }
}

// Fungsi checkRumahOTPStatus - tambahkan penanganan status 'received'
async function checkRumahOTPStatus(orderId) {
  try {
    console.log(`[DEBUG] Checking status for order ${orderId}...`);
    const response = await axios.get(`https://www.rumahotp.io/api/v1/orders/get_status`, {
      params: { order_id: orderId },
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Status response success:', response.data.success);
    if (response.data.data) {
      console.log('[DEBUG] Order status:', response.data.data.status);
      if (response.data.data.otp_code) {
        console.log('[DEBUG] OTP Code found:', response.data.data.otp_code);
      }
    }
    return response.data;
  } catch (error) {
    console.error('[ERROR] Check status failed:', error.response?.data || error.message);
    return { success: false };
  }
}

async function cancelRumahOTPOrder(orderId) {
  try {
    console.log(`[DEBUG] Cancelling order ${orderId}...`);
    const response = await axios.get(`https://www.rumahotp.io/api/v1/orders/set_status`, {
      params: { order_id: orderId, status: 'cancel' },
      headers: {
        'x-apikey': RUMAHOTP_API_KEY,
        'Accept': 'application/json'
      }
    });
    console.log('[DEBUG] Cancel response success:', response.data.success);
    return response.data;
  } catch (error) {
    console.error('[ERROR] Cancel order failed:', error.response?.data || error.message);
    return { success: false };
  }
}

const startId = {
  apikey: 'AZX',
  invoice: 'INV',
  withdraw: 'WD',
  transaction: 'TRX',
  otp: 'OTP'
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  store: new MemoryStore({ checkPeriod: 86400000 }),
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  handler: (req, res) => {
    req.session.errorMsg = 'Terlalu banyak percobaan login. Silakan coba lagi setelah 5 menit.';
    res.redirect('/login');
  }
});

function generateCustomId(prefix) {
  const len = 10 - prefix.length;
  const randomHex = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').substring(0, len);
  return prefix + randomHex;
}

function generateApiKey() {
  return startId.apikey + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

async function createWithRetry(collection, data, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!data._id) {
        if (collection === 'invoices') data._id = generateCustomId(startId.invoice);
        else if (collection === 'transactions') data._id = generateCustomId(startId.transaction);
        else if (collection === 'withdrawals') data._id = generateCustomId(startId.withdraw);
        else if (collection === 'apiKeys') data._id = generateCustomId(startId.apikey);
        else if (collection === 'otpOrders') data._id = generateCustomId(startId.otp);
      }
      
      if (collection === 'apiKeys' && !data.key) {
        data.key = generateApiKey();
      }
      
      const existing = await findOne(collection, { _id: data._id });
      if (existing) {
        if (collection === 'invoices') data._id = generateCustomId(startId.invoice);
        else if (collection === 'transactions') data._id = generateCustomId(startId.transaction);
        else if (collection === 'withdrawals') data._id = generateCustomId(startId.withdraw);
        else if (collection === 'apiKeys') {
          data._id = generateCustomId(startId.apikey);
          data.key = generateApiKey();
        }
        else if (collection === 'otpOrders') data._id = generateCustomId(startId.otp);
        continue;
      }
      return await insertOne(collection, data);
    } catch (err) {
      if (attempt < maxRetries - 1) continue;
      throw err;
    }
  }
  throw new Error('Gagal membuat dokumen setelah beberapa kali percobaan');
}

async function getSettings() {
  let settings = await findOne('settings', {});
  if (!settings) {
    settings = {
      _id: 'settings_1',
      name: 'Azx Gateway',
      title: 'Layanan Payment Gateway',
      description: 'Terima pembayaran melalui QRIS Payment untuk Aplikasi atau Platform Bisnis kamu dengan mudah, cepat, dan aman.',
      channelWhatsApp: 'https://whatsapp.com/channel/0029VbBZsRTL7UVe8r945707',
      apiDomain: 'skyserver.web.id',
      apiKey: 'skyy7',
      username: 'aancuy',
      token: '2163915:TZdCcEk7lX9e2OYWQpnv4fGruBPN80by',
      minDeposit: 1000,
      minWithdraw: 5000,
      feeWithdraw: 1000,
      maxFee: 500,
      checkInterval: 20,
      autoCheckEnabled: true,
      autoBackupEnabled: false,
      autoRestartEnabled: false,
      backupType: 'database',
      restartTime: '03:00',
      backupTime: '00:00',
      smtpUser: '',
      smtpPass: '',
      telegramBotToken: '',
      telegramAdminChatId: '',
      logoUrl: 'https://img2.pixhost.to/images/8187/731158188_skyzo.png'
    };
    await insertOne('settings', settings);
  }
  return settings;
}

async function getStats() {
  const transactions = await readDB('transactions');
  
  const depositPaid = transactions.filter(t => t.type === 'deposit' && t.status === 'paid');
  const withdrawSuccess = transactions.filter(t => t.type === 'withdraw' && t.status === 'success');
  
  const dAmount = depositPaid.reduce((sum, t) => sum + (t.amount || 0), 0);
  const dFee = depositPaid.reduce((sum, t) => sum + (t.fee || 0), 0);
  const wAmount = withdrawSuccess.reduce((sum, t) => sum + (t.amount || 0), 0);
  const wFee = withdrawSuccess.reduce((sum, t) => sum + (t.fee || 0), 0);
  const totalUsers = await countDocuments('users', { role: 'user' });
  const totalTransactions = transactions.length;

  await updateOne('stats', {}, {
    $set: {
      totalDepositAmount: dAmount,
      totalDepositFee: dFee,
      totalWithdrawAmount: wAmount,
      totalWithdrawFee: wFee,
      totalUsers,
      totalTransactions
    }
  }, { upsert: true });

  return { totalDepositAmount: dAmount, totalDepositFee: dFee, totalWithdrawAmount: wAmount, totalWithdrawFee: wFee, totalUsers, totalTransactions };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

async function sendAdminNotification(event, data) {
  const settings = await getSettings();
  const adminChatId = settings.telegramAdminChatId;
  const token = settings.telegramBotToken;
  
  if (!token || !adminChatId) return;
  
  let message = '';
  switch (event) {
    case 'new_register':
      message = `🆕 *Pendaftaran Baru*\n\n👤 Username: ${data.username}\n📧 Email: ${data.email}\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'new_login':
      message = `🔐 *Login Baru*\n\n👤 Username: ${data.username}\n📧 Email: ${data.email}\n🌐 IP: ${data.ip}\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'new_deposit':
      message = `💰 *Deposit Baru*\n\n👤 User: ${data.username}\n💵 Jumlah: Rp ${data.amount.toLocaleString()}\n📝 Status: ${data.status}\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'new_withdraw':
      message = `💸 *Withdraw Baru*\n\n👤 User: ${data.username}\n💵 Jumlah: Rp ${data.amount.toLocaleString()}\n📝 Status: ${data.status}\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'new_otp_order':
      message = `📱 *OTP Order Baru*\n\n👤 User: ${data.username}\n📱 Layanan: ${data.service}\n🌍 Negara: ${data.country}\n📡 Operator: ${data.operator}\n💰 Harga: Rp ${data.price.toLocaleString()}\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'backup_success':
      message = `💾 *Backup Berhasil*\n\n📁 Tipe: ${data.type}\n📊 Ukuran: ${data.size} MB\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
    case 'restart_success':
      message = `🔄 *Restart Server*\n\n✅ Server berhasil direstart\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}`;
      break;
  }
  
  if (message) {
    await sendTelegramMessage(adminChatId, message);
  }
}

async function createBackupZip() {
  return new Promise(async (resolve, reject) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const zipFileName = `backup_db_${timestamp}.zip`;
      const zipFilePath = path.join(__dirname, zipFileName);
      
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`Backup DB berhasil: ${zipFileName}`);
        resolve({ path: zipFilePath, name: zipFileName, size: archive.pointer() });
      });
      
      archive.on('error', (err) => reject(err));
      archive.pipe(output);
      
      if (fs.existsSync(DATA_DIR)) {
        archive.directory(DATA_DIR, 'data');
      } else {
        reject(new Error('Folder data tidak ditemukan'));
      }
      
      await archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}

async function createFullBackupZip() {
  return new Promise(async (resolve, reject) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const zipFileName = `backup_full_${timestamp}.zip`;
      const zipFilePath = path.join(__dirname, zipFileName);
      
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`Full backup berhasil: ${zipFileName}`);
        resolve({ path: zipFilePath, name: zipFileName, size: archive.pointer() });
      });
      
      archive.on('error', (err) => reject(err));
      archive.pipe(output);
      
      archive.glob('**/*', {
        cwd: __dirname,
        ignore: [
          'node_modules/**',
          'package-lock.json',
          '.env',
          'backup_*.zip',
          'backup_db_*.zip',
          'backup_full_*.zip',
          'data/backup_*.json'
        ]
      });
      
      await archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}

async function sendBackupToTelegram(zipPath, zipName, isFull = false) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  const adminChatId = settings.telegramAdminChatId;
  
  if (!token || !adminChatId) {
    console.log('Telegram belum dikonfigurasi, backup hanya disimpan lokal');
    return false;
  }
  
  try {
    const stats = fs.statSync(zipPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    if (stats.size === 0) {
      console.error('File backup kosong!');
      return false;
    }
    
    if (stats.size > 50 * 1024 * 1024) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: adminChatId,
        text: `⚠️ *Backup terlalu besar*\n\nFile backup ${zipName} berukuran ${fileSizeMB} MB melebihi batas Telegram (50MB).\n\nSilakan download manual dari server: ${zipPath}`,
        parse_mode: 'Markdown'
      });
      return false;
    }
    
    const formData = new FormData();
    formData.append('chat_id', adminChatId);
    formData.append('document', fs.createReadStream(zipPath));
    formData.append('caption', `🗄️ *${isFull ? 'Full Backup' : 'Backup Database'}* - ${new Date().toLocaleDateString('id-ID')}\n\n📁 File: ${zipName}\n📊 Ukuran: ${fileSizeMB} MB\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}\n\n⚠️ Simpan file ini dengan aman!`);
    
    await axios.post(`https://api.telegram.org/bot${token}/sendDocument`, formData, {
      headers: { ...formData.getHeaders() }
    });
    
    console.log(`Backup terkirim ke Telegram: ${zipName}`);
    await sendAdminNotification('backup_success', { type: isFull ? 'Full Backup' : 'Database Backup', size: fileSizeMB });
    return true;
  } catch (error) {
    console.error('Gagal kirim backup ke Telegram:', error.message);
    return false;
  }
}

async function performBackup(backupType) {
  try {
    let result;
    if (backupType === 'full') {
      const { path: zipPath, name: zipName } = await createFullBackupZip();
      await sendBackupToTelegram(zipPath, zipName, true);
      setTimeout(() => fs.unlink(zipPath, () => {}), 5000);
      result = { success: true, fileName: zipName };
    } else {
      const { path: zipPath, name: zipName } = await createBackupZip();
      await sendBackupToTelegram(zipPath, zipName, false);
      setTimeout(() => fs.unlink(zipPath, () => {}), 5000);
      result = { success: true, fileName: zipName };
    }
    return result;
  } catch (error) {
    console.error('Backup gagal:', error);
    return { success: false, error: error.message };
  }
}

let restartCronJob = null;
let backupCronJob = null;

async function scheduleAutoRestart() {
  if (restartCronJob) {
    restartCronJob.stop();
    restartCronJob = null;
  }
  
  const settings = await getSettings();
  if (!settings.autoRestartEnabled) {
    console.log('Auto restart dimatikan');
    return;
  }
  
  const [hour, minute] = settings.restartTime.split(':');
  const cronTime = `${minute} ${hour} * * *`;
  
  restartCronJob = cron.schedule(cronTime, async () => {
    console.log(`Auto restart berjalan pada ${new Date().toLocaleString('id-ID')}`);
    await sendAdminNotification('restart_success', {});
    setTimeout(() => process.exit(0), 2000);
  });
  
  console.log(`Auto restart dijadwalkan setiap hari pukul ${settings.restartTime}`);
}

async function scheduleAutoBackup() {
  if (backupCronJob) {
    backupCronJob.stop();
    backupCronJob = null;
  }
  
  const settings = await getSettings();
  if (!settings.autoBackupEnabled) {
    console.log('Auto backup dimatikan');
    return;
  }
  
  const [hour, minute] = settings.backupTime.split(':');
  const cronTime = `${minute} ${hour} * * *`;
  
  backupCronJob = cron.schedule(cronTime, async () => {
    console.log(`Auto backup berjalan pada ${new Date().toLocaleString('id-ID')}`);
    await performBackup(settings.backupType);
  });
  
  console.log(`Auto backup dijadwalkan setiap hari pukul ${settings.backupTime} (tipe: ${settings.backupType})`);
}

let pollingTimeout = null;
let isPollingActive = false;

async function getAdminChatId() {
  const settings = await getSettings();
  return settings.telegramAdminChatId || null;
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token || !chatId) return;
  try {
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload);
  } catch (e) {
    console.error('Telegram sendMessage error:', e.response?.data || e.message);
  }
}

async function deleteMessage(chatId, messageId) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (e) {
    console.error('Telegram deleteMessage error:', e.response?.data || e.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  } catch (e) {}
}

const adminMenuKeyboard = {
  inline_keyboard: [
    [{ text: '📊 Dashboard', callback_data: 'admin_stats' }],
    [{ text: '👥 Users', callback_data: 'admin_users' }, { text: '💰 Withdraw', callback_data: 'admin_withdraw' }],
    [{ text: '📝 Transactions', callback_data: 'admin_transactions' }, { text: '⚙️ Settings', callback_data: 'admin_settings' }],
    [{ text: '💾 Backup DB', callback_data: 'backup_db' }, { text: '📦 Backup Full', callback_data: 'backup_full' }],
    [{ text: '🔄 Restart Server', callback_data: 'restart_server' }]
  ]
};

const mainMenuKeyboard = {
  inline_keyboard: [
    [{ text: '👤 Profile Saya', callback_data: 'my_profile' }],
    [{ text: '💰 Deposit', callback_data: 'deposit_info' }, { text: '💸 Withdraw', callback_data: 'withdraw_info' }],
    [{ text: '📜 Riwayat Transaksi', callback_data: 'my_transactions' }],
    [{ text: '🔑 API Key Saya', callback_data: 'my_apikey' }],
    [{ text: '🛠️ Admin Panel', callback_data: 'admin_panel' }]
  ]
};

async function handleTelegramCommand(msg) {
  const text = msg.text;
  const chatId = msg.chat.id;
  const settings = await getSettings();
  const adminChatId = settings.telegramAdminChatId;
  const isAdminUser = String(chatId) === String(adminChatId);
  
  if (text === '/start') {
    const welcomeText = `🤖 *${settings.name} Bot*\n\nSelamat datang di bot payment gateway!\n\nGunakan menu di bawah untuk mengakses fitur.`;
    await sendTelegramMessage(chatId, welcomeText, isAdminUser ? mainMenuKeyboard : mainMenuKeyboard);
  } else if (text === '/menu') {
    await sendTelegramMessage(chatId, '📋 *Menu Utama*', isAdminUser ? mainMenuKeyboard : mainMenuKeyboard);
  } else if (text === '/backupdb' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Memproses backup database...*', null);
    const result = await performBackup('database');
    if (result.success) {
      await sendTelegramMessage(chatId, `✅ Backup database berhasil: ${result.fileName}`);
    } else {
      await sendTelegramMessage(chatId, `❌ Backup gagal: ${result.error}`);
    }
  } else if (text === '/backupall' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Memproses full backup...*\n\n⏳ Mohon tunggu, proses ini mungkin memakan waktu beberapa saat.', null);
    const result = await performBackup('full');
    if (result.success) {
      await sendTelegramMessage(chatId, `✅ Full backup berhasil: ${result.fileName}`);
    } else {
      await sendTelegramMessage(chatId, `❌ Backup gagal: ${result.error}`);
    }
  } else if (text === '/restart' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Merestart server...*\n\nServer akan online kembali dalam beberapa detik.', null);
    await sendAdminNotification('restart_success', {});
    setTimeout(() => process.exit(0), 2000);
  } else if (text === '/stats' && isAdminUser) {
    const stats = await getStats();
    const statsText = `📊 *Statistik Server*\n\n💰 Total Deposit: Rp ${stats.totalDepositAmount.toLocaleString()}\n💸 Total Withdraw: Rp ${stats.totalWithdrawAmount.toLocaleString()}\n👥 Total Users: ${stats.totalUsers}\n📝 Total Transaksi: ${stats.totalTransactions}\n⏰ Update: ${new Date().toLocaleString('id-ID')}`;
    await sendTelegramMessage(chatId, statsText);
  } else if (text === '/users' && isAdminUser) {
    const users = await readDB('users');
    const userList = users.filter(u => u.role === 'user').slice(0, 10);
    let userText = `👥 *Daftar User (10 terbaru)*\n\n`;
    for (const u of userList) {
      userText += `• ${u.username} - Saldo: Rp ${(u.balance || 0).toLocaleString()}\n`;
    }
    userText += `\nTotal user: ${users.filter(u => u.role === 'user').length}`;
    await sendTelegramMessage(chatId, userText);
  }
}

async function handleCallbackQuery(cb) {
  const data = cb.data;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const settings = await getSettings();
  const adminChatId = settings.telegramAdminChatId;
  const isAdminUser = String(chatId) === String(adminChatId);
  
  await answerCallbackQuery(cb.id, 'Processing...');
  
  if (data === 'admin_panel' && isAdminUser) {
    await sendTelegramMessage(chatId, '🛠️ *Admin Panel*\n\nPilih menu di bawah:', adminMenuKeyboard);
    await deleteMessage(chatId, messageId);
  } else if (data === 'admin_stats' && isAdminUser) {
    const stats = await getStats();
    const statsText = `📊 *Statistik Server*\n\n💰 Total Deposit: Rp ${stats.totalDepositAmount.toLocaleString()}\n💸 Total Withdraw: Rp ${stats.totalWithdrawAmount.toLocaleString()}\n👥 Total Users: ${stats.totalUsers}\n📝 Total Transaksi: ${stats.totalTransactions}`;
    await sendTelegramMessage(chatId, statsText);
  } else if (data === 'admin_users' && isAdminUser) {
    const users = await readDB('users');
    const userList = users.filter(u => u.role === 'user').slice(0, 15);
    let userText = `👥 *Daftar User (15 terbaru)*\n\n`;
    for (const u of userList) {
      userText += `• *${u.username}* - Saldo: Rp ${(u.balance || 0).toLocaleString()}\n  Status: ${u.suspended ? '⛔ Suspended' : '✅ Active'}\n\n`;
    }
    userText += `📊 Total user: ${users.filter(u => u.role === 'user').length}`;
    await sendTelegramMessage(chatId, userText);
  } else if (data === 'admin_withdraw' && isAdminUser) {
    const withdrawals = await readDB('withdrawals');
    const pendingWd = withdrawals.filter(w => w.status === 'pending').slice(0, 10);
    if (pendingWd.length === 0) {
      await sendTelegramMessage(chatId, '✅ Tidak ada withdraw pending saat ini.');
    } else {
      let wdText = `💸 *Withdraw Pending (10 terbaru)*\n\n`;
      for (const w of pendingWd) {
        const user = await findById('users', w.userId);
        wdText += `• ID: \`${w._id}\`\n  User: ${user?.username || 'Unknown'}\n  Amount: Rp ${(w.amount + w.fee).toLocaleString()}\n  Waktu: ${new Date(w.createdAt).toLocaleString('id-ID')}\n\n`;
      }
      await sendTelegramMessage(chatId, wdText);
    }
  } else if (data === 'admin_transactions' && isAdminUser) {
    const transactions = await readDB('transactions');
    const recentTx = transactions.slice(0, 10);
    let txText = `📝 *Transaksi Terbaru (10)*\n\n`;
    for (const t of recentTx) {
      const user = await findById('users', t.userId);
      txText += `• ${t.type === 'deposit' ? '💰 Deposit' : '💸 Withdraw'} - ${user?.username || 'Unknown'}\n  Amount: Rp ${(t.amount || 0).toLocaleString()}\n  Status: ${t.status}\n  Waktu: ${new Date(t.createdAt).toLocaleString('id-ID')}\n\n`;
    }
    await sendTelegramMessage(chatId, txText);
  } else if (data === 'admin_settings' && isAdminUser) {
    const settingsText = `⚙️ *Pengaturan Saat Ini*\n\n🏷️ Nama: ${settings.name}\n💰 Min Deposit: Rp ${settings.minDeposit.toLocaleString()}\n💸 Min Withdraw: Rp ${settings.minWithdraw.toLocaleString()}\n📊 Fee Withdraw: Rp ${settings.feeWithdraw.toLocaleString()}\n🔄 Auto Cek Mutasi: ${settings.autoCheckEnabled ? '✅ Aktif' : '❌ Nonaktif'}\n💾 Auto Backup: ${settings.autoBackupEnabled ? '✅ Aktif' : '❌ Nonaktif'}\n🔄 Auto Restart: ${settings.autoRestartEnabled ? '✅ Aktif' : '❌ Nonaktif'}\n⏰ Waktu Restart: ${settings.restartTime || '03:00'}\n⏰ Waktu Backup: ${settings.backupTime || '00:00'}\n📦 Tipe Backup: ${settings.backupType === 'full' ? 'Full Script' : 'Database Only'}\n\n📱 Telegram Bot: ${settings.telegramBotToken ? '✅ Terkonfigurasi' : '❌ Belum'}`;
    await sendTelegramMessage(chatId, settingsText);
  } else if (data === 'backup_db' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Memproses backup database...*\n\n⏳ Mohon tunggu.', null);
    await performBackup('database');
  } else if (data === 'backup_full' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Memproses full backup...*\n\n⏳ Mohon tunggu, proses ini mungkin memakan waktu beberapa saat.', null);
    await performBackup('full');
  } else if (data === 'restart_server' && isAdminUser) {
    await sendTelegramMessage(chatId, '🔄 *Merestart server...*\n\nServer akan online kembali dalam beberapa detik.', null);
    await sendAdminNotification('restart_success', {});
    setTimeout(() => process.exit(0), 2000);
  } else if (data === 'main_menu') {
    await sendTelegramMessage(chatId, '📋 *Menu Utama*', isAdminUser ? mainMenuKeyboard : mainMenuKeyboard);
    await deleteMessage(chatId, messageId);
  } else if (data === 'my_profile') {
    const userRecord = await findOne('users', { telegramId: String(chatId) });
    if (userRecord) {
      const profileText = `👤 *Profil Saya*\n\nUsername: ${userRecord.username}\nEmail: ${userRecord.email}\nSaldo: Rp ${(userRecord.balance || 0).toLocaleString()}\nE-Wallet: ${userRecord.ewallet || 'Belum diisi'}\nStatus: ${userRecord.suspended ? '⛔ Suspended' : '✅ Active'}`;
      await sendTelegramMessage(chatId, profileText);
    } else {
      await sendTelegramMessage(chatId, '❌ Akun tidak ditemukan. Silakan login terlebih dahulu di website.');
    }
  } else if (data === 'deposit_info') {
    await sendTelegramMessage(chatId, `💰 *Informasi Deposit*\n\nMinimal deposit: Rp ${settings.minDeposit.toLocaleString()}\n\nSilakan login ke website untuk melakukan deposit.\n\nWebsite: ${settings.apiDomain || 'belum diset'}`);
  } else if (data === 'withdraw_info') {
    await sendTelegramMessage(chatId, `💸 *Informasi Withdraw*\n\nMinimal withdraw: Rp ${settings.minWithdraw.toLocaleString()}\nBiaya admin: Rp ${settings.feeWithdraw.toLocaleString()}\n\nSilakan login ke website untuk melakukan withdraw.\n\nWebsite: ${settings.apiDomain || 'belum diset'}`);
  } else if (data === 'my_transactions') {
    const userRecord = await findOne('users', { telegramId: String(chatId) });
    if (userRecord) {
      const transactions = await readDB('transactions');
      const userTx = transactions.filter(t => t.userId === userRecord._id).slice(0, 10);
      if (userTx.length === 0) {
        await sendTelegramMessage(chatId, '📜 Belum ada transaksi.');
      } else {
        let txText = `📜 *Riwayat Transaksi (10 terbaru)*\n\n`;
        for (const t of userTx) {
          txText += `• ${t.type === 'deposit' ? '💰 Deposit' : '💸 Withdraw'}\n  Amount: Rp ${(t.amount || 0).toLocaleString()}\n  Status: ${t.status}\n  Waktu: ${new Date(t.createdAt).toLocaleString('id-ID')}\n\n`;
        }
        await sendTelegramMessage(chatId, txText);
      }
    } else {
      await sendTelegramMessage(chatId, '❌ Akun tidak ditemukan.');
    }
  } else if (data === 'my_apikey') {
    const userRecord = await findOne('users', { telegramId: String(chatId) });
    if (userRecord) {
      const apiKey = await findOne('apiKeys', { userId: userRecord._id });
      await sendTelegramMessage(chatId, `🔑 *API Key Saya*\n\n\`${apiKey?.key || 'Belum dibuat'}\`\n\nGunakan API key ini untuk mengakses API endpoint.\n\n⚠️ Jangan bagikan API key kepada siapapun!`);
    } else {
      await sendTelegramMessage(chatId, '❌ Akun tidak ditemukan.');
    }
  }
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  } else if (update.message && update.message.text) {
    await handleTelegramCommand(update.message);
  }
}

async function telegramGetUpdates(offset) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return [];
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      params: { offset, timeout: 15 },
      timeout: 20000
    });
    if (res.data.ok) return res.data.result;
    return [];
  } catch (e) {
    if (e.response && e.response.status === 409) {
      console.error('Error 409 Conflict terdeteksi, menghentikan polling.');
      stopTelegramPolling();
    }
    return [];
  }
}

function stopTelegramPolling() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  isPollingActive = false;
}

async function ensureNoWebhook(token) {
  try {
    const infoRes = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    if (infoRes.data.ok && infoRes.data.result.url) {
      console.log('Webhook terdeteksi, menghapus...');
      await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook`);
      console.log('Webhook dihapus.');
    }
    return true;
  } catch (e) {
    console.error('Gagal menghapus webhook:', e.message);
    return false;
  }
}

async function startTelegramPolling() {
  stopTelegramPolling();
  const settings = await getSettings();
  if (!settings.telegramBotToken) {
    console.log('Telegram bot token belum dikonfigurasi');
    return;
  }
  if (isPollingActive) {
    console.log('Polling sudah berjalan.');
    return;
  }
  const ok = await ensureNoWebhook(settings.telegramBotToken);
  if (!ok) {
    console.log('Tidak dapat memastikan webhook, polling tidak dimulai.');
    return;
  }
  isPollingActive = true;
  console.log('Polling Telegram dimulai.');
  let offset = 0;
  async function poll() {
    if (!isPollingActive) return;
    const updates = await telegramGetUpdates(offset);
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleTelegramUpdate(update);
    }
    pollingTimeout = setTimeout(poll, 1000);
  }
  poll();
}

app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    try {
      res.locals.user = await findById('users', req.session.userId);
    } catch {}
  }
  res.locals.settings = await getSettings();
  res.locals.error = req.session.errorMsg || null;
  res.locals.success = req.session.successMsg || null;
  delete req.session.errorMsg;
  delete req.session.successMsg;
  next();
});

function isAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.userRole === 'admin') return next();
  res.redirect('/login');
}

async function seed() {
  const admin = await findOne('users', { role: 'admin' });
  if (!admin) {
    await insertOne('users', {
      _id: crypto.randomBytes(12).toString('hex'),
      username: 'admin',
      email: 'admin@gmail.com',
      password: hashPassword('admin123'),
      role: 'admin',
      balance: 0,
      suspended: false,
      ewallet: '',
      accountNumber: '',
      accountName: '',
      createdAt: new Date()
    });
    console.log(`Admin Account Default\nUsername: admin\nPassword: admin123`);
  }
}

app.get('/', (req, res) => res.render('home'));
app.get('/home', (req, res) => res.render('home'));
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('login');
});
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('register');
});

app.post('/login', Limiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    req.session.errorMsg = 'Harap isi semua field';
    return res.redirect('/login');
  }
  const isEmail = login.includes('@');
  let user;
  if (isEmail) {
    user = await findOne('users', { email: login.toLowerCase() });
    if (user && user.role === 'admin') {
      req.session.errorMsg = 'Admin hanya dapat login menggunakan username';
      return res.redirect('/login');
    }
  } else {
    user = await findOne('users', { username: login.toLowerCase() });
  }
  if (!user || !verifyPassword(password, user.password)) {
    req.session.errorMsg = 'Username/email atau kata sandi salah';
    return res.redirect('/login');
  }
  if (user.suspended) {
    req.session.errorMsg = 'Akun Anda dinonaktifkan';
    return res.redirect('/login');
  }
  req.session.userId = user._id;
  req.session.userRole = user.role;
  
  await sendAdminNotification('new_login', {
    username: user.username,
    email: user.email,
    ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress
  });
  
  if (user.role === 'admin') return res.redirect('/admin/dashboard');
  res.redirect('/dashboard');
});

app.post('/register', Limiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || username.trim().length === 0) {
    req.session.errorMsg = 'Username tidak boleh kosong';
    return res.redirect('/register');
  }
  if (!/^[a-zA-Z0-9]+$/.test(username)) {
    req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
    return res.redirect('/register');
  }
  if (username.length > 15) {
    req.session.errorMsg = 'Username maksimal 15 karakter';
    return res.redirect('/register');
  }
  try {
    const existingUser = await findOne('users', { $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }] });
    if (existingUser) {
      req.session.errorMsg = 'Username atau email sudah terdaftar';
      return res.redirect('/register');
    }
    
    const user = {
      _id: crypto.randomBytes(12).toString('hex'),
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: hashPassword(password),
      balance: 0,
      role: 'user',
      suspended: false,
      ewallet: '',
      accountNumber: '',
      accountName: '',
      createdAt: new Date()
    };
    await insertOne('users', user);
    
    const apiKeyData = {
      _id: generateCustomId(startId.apikey),
      userId: user._id,
      key: generateApiKey(),
      createdAt: new Date()
    };
    await insertOne('apiKeys', apiKeyData);
    
    req.session.userId = user._id;
    req.session.userRole = 'user';
    
    await sendAdminNotification('new_register', {
      username: user.username,
      email: user.email
    });
    
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Register error:', err);
    req.session.errorMsg = 'Gagal mendaftar, periksa kembali data Anda';
    res.redirect('/register');
  }
});

app.post('/check-availability', async (req, res) => {
  const { type, value } = req.body;
  if (!type || !value || !['username', 'email'].includes(type)) {
    return res.json({ available: false, message: 'Parameter tidak valid' });
  }

  if (type === 'username') {
    if (!/^[a-zA-Z0-9]{1,15}$/.test(value)) {
      return res.json({ available: false, message: 'Format username tidak valid (huruf/angka, maks 15 karakter)' });
    }
    const exists = await findOne('users', { username: value.toLowerCase() });
    return res.json({ available: !exists, message: exists ? 'Username sudah digunakan' : 'Username tersedia' });
  }

  if (type === 'email') {
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      return res.json({ available: false, message: 'Format email tidak valid' });
    }
    const exists = await findOne('users', { email: value.toLowerCase() });
    return res.json({ available: !exists, message: exists ? 'Email sudah terdaftar' : 'Email tersedia' });
  }
});

app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('forgot_password');
});

app.post('/forgot-password', Limiter, async (req, res) => {
  const { login } = req.body;
  if (!login) {
    req.session.errorMsg = 'Harap masukkan email atau username Anda.';
    return res.redirect('/forgot-password');
  }
  try {
    const settings = await getSettings();
    if (!settings.smtpUser || !settings.smtpPass) {
      req.session.errorMsg = 'Fitur pengiriman email belum dikonfigurasi oleh Administrator.';
      return res.redirect('/forgot-password');
    }
    const isEmail = login.includes('@');
    let user;
    if (isEmail) {
      user = await findOne('users', { email: login.toLowerCase() });
    } else {
      user = await findOne('users', { username: login.toLowerCase() });
    }
    if (!user) {
      req.session.errorMsg = 'Akun tidak ditemukan di sistem kami.';
      return res.redirect('/forgot-password');
    }
    if (!user.email) {
      req.session.errorMsg = 'Akun ini tidak memiliki alamat email yang valid.';
      return res.redirect('/forgot-password');
    }
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 30 * 60 * 1000;
    await updateById('users', user._id, { $set: user });

    const resetLink = `http://${req.headers.host}/reset-password/${token}`;
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: settings.smtpUser,
        pass: settings.smtpPass
      },
      tls: { rejectUnauthorized: false }
    });

    await transporter.sendMail({
      to: user.email,
      from: `"${settings.name}" <${settings.smtpUser}>`,
      subject: `Permintaan Reset Password - ${settings.name}`,
      text: `Halo ${user.username},\n\nKami menerima permintaan untuk mengatur ulang kata sandi akun Anda. Silakan salin tautan berikut ke browser Anda:\n${resetLink}\n\nTautan ini hanya berlaku 30 menit.\n\nJika Anda tidak meminta ini, abaikan email ini.`,
      html: `<div>Reset password link: <a href="${resetLink}">${resetLink}</a></div>`
    });

    req.session.successMsg = `Link reset password telah dikirim ke email Anda yang terdaftar.`;
    res.redirect('/forgot-password');
  } catch (error) {
    console.error('Error Forgot Password:', error);
    req.session.errorMsg = 'Gagal memproses email. Pastikan konfigurasi SMTP di Admin valid.';
    res.redirect('/forgot-password');
  }
});

app.get('/reset-password/:token', async (req, res) => {
  try {
    const users = await readDB('users');
    const user = users.find(u => u.resetPasswordToken === req.params.token && u.resetPasswordExpires > Date.now());
    if (!user) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa (berlaku 30 menit).';
      return res.redirect('/forgot-password');
    }
    res.render('reset_password', { token: req.params.token });
  } catch (error) {
    res.redirect('/login');
  }
});

app.post('/reset-password/:token', async (req, res) => {
  try {
    const users = await readDB('users');
    const userIndex = users.findIndex(u => u.resetPasswordToken === req.params.token && u.resetPasswordExpires > Date.now());
    if (userIndex === -1) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa.';
      return res.redirect('/forgot-password');
    }
    const { password, confirmPassword } = req.body;
    if (password !== confirmPassword) {
      req.session.errorMsg = 'Password dan konfirmasi password tidak cocok.';
      return res.redirect(`/reset-password/${req.params.token}`);
    }
    users[userIndex].password = hashPassword(password);
    delete users[userIndex].resetPasswordToken;
    delete users[userIndex].resetPasswordExpires;
    await writeDB('users', users);
    req.session.successMsg = 'Password berhasil diubah. Silakan login dengan password baru.';
    res.redirect('/login');
  } catch (error) {
    req.session.errorMsg = 'Gagal mereset password.';
    res.redirect(`/reset-password/${req.params.token}`);
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/dashboard', isAuth, async (req, res) => {
  if (req.session.userRole === 'admin') return res.redirect('/admin/dashboard');
  const userId = req.session.userId;
  const user = res.locals.user || { balance: 0 };
  
  const transactions = await readDB('transactions');
  const userTransactions = transactions.filter(t => t.userId === user._id);
  const totalDeposit = userTransactions.filter(t => t.type === 'deposit' && t.status === 'paid').reduce((sum, t) => sum + (t.amount || 0), 0);
  const totalWithdraw = userTransactions.filter(t => t.type === 'withdraw' && t.status === 'success').reduce((sum, t) => sum + (t.amount || 0), 0);
  const recentTrx = userTransactions.filter(t => t.type === 'deposit').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const apiKeys = await find('apiKeys', { userId });
  
  // Ambil semua notifikasi untuk ditampilkan di berita
  const allNotifications = await getNotifications();
  // Filter notifikasi yang aktif (isActive = true)
  const activeNotifications = allNotifications.filter(n => n.isActive === true);
  
  res.render('dashboard', { 
    user: user || { balance: 0, username: '', email: '' }, 
    totalDeposit: totalDeposit || 0, 
    totalWithdraw: totalWithdraw || 0, 
    recentTrx: recentTrx || [], 
    apiKeys: apiKeys || [],
    allNotifications: activeNotifications || []  // Kirim ke view
  });
});

app.get('/profile', isAuth, (req, res) => res.render('profile'));
app.post('/profile', isAuth, async (req, res) => {
  const { email, newPassword, ewallet, accountNumber, accountName } = req.body;
  try {
    const user = await findById('users', req.session.userId);
    if (email && email !== user.email) {
      const existing = await findOne('users', { email: email.toLowerCase() });
      if (existing && existing._id !== req.session.userId) {
        req.session.errorMsg = 'Email sudah digunakan oleh pengguna lain';
        return res.redirect('/profile');
      }
      user.email = email.toLowerCase();
    }
    user.ewallet = ewallet || '';
    user.accountNumber = accountNumber || '';
    user.accountName = accountName || '';
    if (newPassword && newPassword.trim()) {
      user.password = hashPassword(newPassword);
    }
    await updateById('users', req.session.userId, { $set: user });
    req.session.successMsg = 'Profil berhasil diperbarui';
    res.redirect('/profile');
  } catch (err) {
    req.session.errorMsg = 'Gagal memperbarui profil';
    res.redirect('/profile');
  }
});

app.post('/api/user/api-key/regenerate', isAuth, async (req, res) => {
  await deleteMany('apiKeys', { userId: req.session.userId });
  const key = generateApiKey();
  try {
    await createWithRetry('apiKeys', { userId: req.session.userId, key, createdAt: new Date() });
    res.json({ apiKey: key });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat API key' });
  }
});

app.get('/deposit', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const transactions = await readDB('transactions');
  const deposits = transactions.filter(t => t.userId === req.session.userId && t.type === 'deposit').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const invoices = await find('invoices', { userId: req.session.userId });
  res.render('deposit', { deposits, invoices: invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), minDeposit: settings.minDeposit });
});

app.post('/invoice/create', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const userId = req.session.userId;
  const amount = parseInt(req.body.amount);
  if (isNaN(amount) || amount < settings.minDeposit) {
    req.session.errorMsg = `Minimal deposit adalah Rp ${settings.minDeposit.toLocaleString('id-ID')}`;
    return res.redirect('/deposit');
  }
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const invoices = await readDB('invoices');
    const lockedInvoices = invoices.filter(i => i.status === 'pending' || (i.status === 'paid' && new Date(i.createdAt) >= oneDayAgo));
    const usedFees = lockedInvoices.map(i => Number(i.fee)).filter(f => !isNaN(f));
    const availableFees = [];
    for (let i = 1; i <= settings.maxFee; i++) {
      if (!usedFees.includes(i)) availableFees.push(i);
    }
    if (availableFees.length === 0) {
      req.session.errorMsg = 'Kode unik deposit sedang penuh. Silakan coba lagi beberapa menit.';
      return res.redirect('/deposit');
    }
    const fee = availableFees[Math.floor(Math.random() * availableFees.length)];
    const total = amount + fee;
    const url = `https://${settings.apiDomain}/?action=createpayment&apikey=${settings.apiKey}&username=${settings.username}&amount=${total}&token=${settings.token}`;
    const resp = await axios.get(url);
    const data = resp.data;
    if (!data.status) throw new Error('Gagal membuat QRIS dari gateway');
    const expiredAt = new Date(Date.now() + 10 * 60 * 1000);
    const invoice = await createWithRetry('invoices', {
      _id: generateCustomId(startId.invoice),
      userId, amount, fee, total,
      trxid: data.result.trxid,
      qris_image: data.result.qris_image,
      expiredAt,
      status: 'pending',
      mutationId: null,
      createdAt: new Date()
    });
    await createWithRetry('transactions', {
      _id: generateCustomId(startId.transaction),
      userId, type: 'deposit', amount, fee,
      status: 'pending',
      reference: invoice._id.toString(),
      expiredAt,
      createdAt: new Date()
    });
    
    const user = await findById('users', userId);
    await sendAdminNotification('new_deposit', {
      username: user.username,
      amount: amount,
      status: 'pending'
    });
    
    return res.redirect(`/invoice/${invoice._id}`);
  } catch (e) {
    console.error('Create invoice error:', e.response?.data || e.message);
    req.session.errorMsg = 'Gagal membuat invoice deposit. Silakan coba lagi.';
    return res.redirect('/deposit');
  }
});

app.get('/invoice/:id', isAuth, async (req, res) => {
  const inv = await findById('invoices', req.params.id);
  if (!inv || inv.userId !== req.session.userId) return res.status(404).send('Tidak ditemukan');
  res.render('invoice_detail', { inv });
});

app.get('/withdraw', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const withdrawals = await find('withdrawals', { userId: req.session.userId });
  res.render('withdraw', { settings, withdrawals: withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/withdraw/request', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const user = res.locals.user;
  if (!user.ewallet || !user.accountNumber || !user.accountName) {
    req.session.errorMsg = 'Harap lengkapi data E-Wallet di Profil terlebih dahulu.';
    return res.redirect('/withdraw');
  }
  const { amount } = req.body;
  const amt = parseInt(amount);
  const fee = settings.feeWithdraw || 0;
  const totalDeduct = amt + fee;
  if (isNaN(amt) || amt < settings.minWithdraw) {
    req.session.errorMsg = 'Minimal penarikan Rp ' + settings.minWithdraw;
    return res.redirect('/withdraw');
  }
  
  if (user.balance < totalDeduct) {
    req.session.errorMsg = 'Saldo tidak cukup (termasuk biaya admin Rp ' + fee.toLocaleString() + ')';
    return res.redirect('/withdraw');
  }
  
  user.balance -= totalDeduct;
  await updateById('users', req.session.userId, { $set: user });
  
  try {
    const ref = 'W' + Date.now().toString(36).toUpperCase();
    const wd = await createWithRetry('withdrawals', {
      _id: generateCustomId(startId.withdraw),
      userId: req.session.userId, amount: amt, fee,
      method: user.ewallet, accountNumber: user.accountNumber, accountName: user.accountName,
      status: 'pending',
      adminNote: null,
      createdAt: new Date()
    });
    await createWithRetry('transactions', {
      _id: generateCustomId(startId.transaction),
      userId: req.session.userId, type: 'withdraw', amount: amt, fee,
      status: 'pending', reference: ref,
      createdAt: new Date()
    });
    
    await sendAdminNotification('new_withdraw', {
      username: user.username,
      amount: amt + fee,
      status: 'pending'
    });
    
    const adminChatId = await getAdminChatId();
    if (adminChatId) {
      const userForMsg = await findById('users', req.session.userId);
      const timeString = new Date(wd.createdAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).replace(/, /, ' pukul ');
      const header = `🌐 *Notifikasi - ${settings.name}*\n\n`;
      const userInfo = `👤 *Informasi User*\n• *User:* ${userForMsg.username} (${userForMsg.email})\n• *Saldo Saat Ini:* Rp ${user.balance.toLocaleString()}\n• *E-Wallet:* ${user.ewallet}\n• *No. Rek:* \`${user.accountNumber}\`\n• *Nama Rek:* ${user.accountName}\n\n`;
      const withdrawInfo = `📤 Informasi Withdraw\n• *Jumlah:* Rp ${amt.toLocaleString()}\n• *Biaya:* Rp ${fee.toLocaleString()}\n• *Total Penarikan:* Rp ${totalDeduct.toLocaleString()}\n• *Waktu:* ${timeString}\n`;
      const inlineKeyboard = {
        inline_keyboard: [[
          { text: '✅ Setujui', callback_data: `approve_wd:${wd._id}` },
          { text: '❌ Tolak', callback_data: `reason_wd:${wd._id}` }
        ]]
      };
      sendTelegramMessage(adminChatId, header + userInfo + withdrawInfo, inlineKeyboard);
    }
    req.session.successMsg = 'Penarikan berhasil diajukan dan sedang diproses.';
  } catch (err) {
    user.balance += totalDeduct;
    await updateById('users', req.session.userId, { $set: user });
    req.session.errorMsg = 'Gagal memproses penarikan sistem.';
  }
  res.redirect('/withdraw');
});

app.get('/admin/dashboard', isAuth, isAdmin, async (req, res) => {
  const stats = await getStats();
  res.render('admin_dashboard', stats);
});

app.get('/admin/users', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let users = await readDB('users');
  users = users.filter(u => u.role === 'user');
  if (search) {
    users = users.filter(u => 
      u.email.toLowerCase().includes(search.toLowerCase()) || 
      u.username.toLowerCase().includes(search.toLowerCase())
    );
  }
  users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin_users', { users, search });
});

app.get('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const targetUser = await findById('users', req.params.id);
  if (!targetUser) return res.status(404).send('Tidak ditemukan');
  res.render('admin_user_edit', { users: targetUser });
});

app.post('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const { username, email, password, balance, suspended } = req.body;
  if (username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
  }
  const user = await findById('users', req.params.id);
  if (!user) {
    req.session.errorMsg = 'User tidak ditemukan';
    return res.redirect('/admin/users');
  }
  
  if (username) user.username = username.toLowerCase();
  if (email) user.email = email.toLowerCase();
  if (balance !== undefined) user.balance = parseInt(balance) || 0;
  user.suspended = suspended === 'on';
  if (password && password.trim()) user.password = hashPassword(password);
  
  try {
    await updateById('users', req.params.id, { $set: user });
    req.session.successMsg = 'Data pengguna berhasil diperbarui';
    res.redirect('/admin/users');
  } catch (err) {
    req.session.errorMsg = 'Gagal memperbarui data pengguna';
    res.redirect(`/admin/users/${req.params.id}/edit`);
  }
});

app.post('/admin/users/:id/delete', isAuth, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const userToDelete = await findById('users', userId);
    if (!userToDelete) {
      req.session.errorMsg = 'User tidak ditemukan.';
      return res.redirect('/admin/users');
    }
    if (userToDelete.role === 'admin') {
      req.session.errorMsg = 'Tidak dapat menghapus akun admin.';
      return res.redirect('/admin/users');
    }
    await deleteMany('invoices', { userId });
    await deleteMany('transactions', { userId });
    await deleteMany('withdrawals', { userId });
    await deleteMany('apiKeys', { userId });
    await deleteOne('users', { _id: userId });
    req.session.successMsg = 'User berhasil dihapus beserta seluruh data terkait.';
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    req.session.errorMsg = 'Gagal menghapus user.';
    res.redirect('/admin/users');
  }
});

app.get('/admin/withdraw', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let withdrawals = await readDB('withdrawals');
  
  if (search) {
    const users = await readDB('users');
    const matchedUsers = users.filter(u => 
      u.email.toLowerCase().includes(search.toLowerCase()) || 
      u.username.toLowerCase().includes(search.toLowerCase())
    ).map(u => u._id);
    withdrawals = withdrawals.filter(w => matchedUsers.includes(w.userId));
  }
  
  for (const w of withdrawals) {
    const user = await findById('users', w.userId);
    if (user) {
      w.username = user.username;
      w.email = user.email;
    }
  }
  withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin_withdraw', { withdrawals, search });
});

app.post('/admin/withdraw/success/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await findById('withdrawals', req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'success';
    await updateById('withdrawals', wd._id, { $set: wd });
    
    const transactions = await find('transactions', { userId: wd.userId, type: 'withdraw', status: 'pending' });
    const pendingWithdraw = transactions.find(t => t.reference && t.reference.startsWith('W'));
    if (pendingWithdraw) {
      pendingWithdraw.status = 'success';
      await updateById('transactions', pendingWithdraw._id, { $set: pendingWithdraw });
    }
    
    await updateOne('stats', {}, { $inc: { totalWithdrawAmount: wd.amount, totalWithdrawFee: wd.fee } });
    req.session.successMsg = 'Penarikan berhasil disetujui.';
  }
  res.redirect('/admin/withdraw');
});

app.post('/admin/withdraw/reject/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await findById('withdrawals', req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'rejected';
    wd.adminNote = req.body.note || '';
    await updateById('withdrawals', wd._id, { $set: wd });
    
    const user = await findById('users', wd.userId);
    user.balance += wd.amount + wd.fee;
    await updateById('users', wd.userId, { $set: user });
    
    const transactions = await find('transactions', { userId: wd.userId, type: 'withdraw', status: 'pending' });
    const pendingWithdraw = transactions.find(t => t.reference && t.reference.startsWith('W'));
    if (pendingWithdraw) {
      pendingWithdraw.status = 'rejected';
      await updateById('transactions', pendingWithdraw._id, { $set: pendingWithdraw });
    }
    
    req.session.successMsg = 'Penarikan ditolak dan saldo dikembalikan.';
  }
  res.redirect('/admin/withdraw');
});

app.get('/admin/transactions', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let transactions = await readDB('transactions');
  
  if (search) {
    const users = await readDB('users');
    const matchedUsers = users.filter(u => 
      u.email.toLowerCase().includes(search.toLowerCase()) || 
      u.username.toLowerCase().includes(search.toLowerCase())
    ).map(u => u._id);
    transactions = transactions.filter(t => 
      matchedUsers.includes(t.userId) || 
      (t.reference && t.reference.toLowerCase().includes(search.toLowerCase()))
    );
  }
  
  for (const t of transactions) {
    const user = await findById('users', t.userId);
    if (user) {
      t.username = user.username;
      t.email = user.email;
    }
  }
  transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin_transactions', { transactions, search });
});

app.get('/admin/account', isAuth, isAdmin, async (req, res) => {
  const admin = await findById('users', req.session.userId);
  res.render('admin_account', { admin });
});

app.post('/admin/account', isAuth, isAdmin, async (req, res) => {
  const { username, password, newPassword } = req.body;
  const admin = await findById('users', req.session.userId);
  if (!password || !verifyPassword(password, admin.password)) {
    req.session.errorMsg = 'Password saat ini salah';
    return res.redirect('/admin/account');
  }
  if (username && username !== admin.username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect('/admin/account');
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect('/admin/account');
    }
    const existing = await findOne('users', { username: username.toLowerCase() });
    if (existing && existing._id !== admin._id) {
      req.session.errorMsg = 'Username sudah digunakan oleh pengguna lain';
      return res.redirect('/admin/account');
    }
  }
  try {
    if (username && username !== admin.username) admin.username = username.toLowerCase();
    if (newPassword && newPassword.trim()) admin.password = hashPassword(newPassword);
    await updateById('users', req.session.userId, { $set: admin });
    req.session.successMsg = 'Data akun berhasil diperbarui';
  } catch (e) {
    req.session.errorMsg = 'Gagal memperbarui akun';
  }
  res.redirect('/admin/account');
});

app.post('/admin/settings/reset', isAuth, isAdmin, async (req, res) => {
  try {
    const users = await readDB('users');
    const adminUser = users.find(u => u.role === 'admin');
    
    await writeDB('users', adminUser ? [adminUser] : []);
    await writeDB('invoices', []);
    await writeDB('transactions', []);
    await writeDB('withdrawals', []);
    await writeDB('apiKeys', []);
    await writeDB('stats', [{
      totalDepositAmount: 0,
      totalDepositFee: 0,
      totalWithdrawAmount: 0,
      totalWithdrawFee: 0,
      totalUsers: 0,
      totalTransactions: 0
    }]);

    req.session.successMsg = 'Database berhasil direset. Semua data pengguna, invoice, transaksi, dan withdrawal telah dihapus.';
  } catch (error) {
    console.error('Reset database error:', error);
    req.session.errorMsg = 'Gagal mereset database. Silakan coba lagi.';
  }
  res.redirect('/admin/settings');
});

app.get('/admin/settings', isAuth, isAdmin, async (req, res) => {
  res.render('admin_settings');
});

app.post('/admin/settings', isAuth, isAdmin, async (req, res) => {
  const { 
    name, title, description, apiDomain, apiKey, username, token, 
    minDeposit, minWithdraw, channelWhatsApp, feeWithdraw, maxFee, 
    checkInterval, autoCheckEnabled, autoBackupEnabled, autoRestartEnabled,
    backupType, restartTime, backupTime,
    smtpUser, smtpPass, telegramBotToken, telegramAdminChatId, logoUrl 
  } = req.body;
  
  const settings = await getSettings();
  settings.name = name;
  settings.title = title;
  settings.description = description;
  settings.apiDomain = apiDomain;
  settings.apiKey = apiKey;
  settings.username = username;
  settings.token = token;
  settings.minDeposit = parseInt(minDeposit);
  settings.minWithdraw = parseInt(minWithdraw);
  settings.feeWithdraw = parseInt(feeWithdraw);
  settings.maxFee = parseInt(maxFee);
  settings.channelWhatsApp = channelWhatsApp;
  settings.checkInterval = parseInt(checkInterval);
  settings.autoCheckEnabled = autoCheckEnabled === 'on';
  settings.autoBackupEnabled = autoBackupEnabled === 'on';
  settings.autoRestartEnabled = autoRestartEnabled === 'on';
  settings.backupType = backupType || 'database';
  settings.restartTime = restartTime || '03:00';
  settings.backupTime = backupTime || '00:00';
  settings.smtpUser = smtpUser;
  settings.smtpPass = smtpPass;
  settings.telegramBotToken = telegramBotToken;
  settings.telegramAdminChatId = telegramAdminChatId;
  settings.logoUrl = logoUrl;
  
  await updateById('settings', settings._id, { $set: settings });
  startChecker();
  startTelegramPolling();
  scheduleAutoBackup();
  scheduleAutoRestart();
  req.session.successMsg = 'Pengaturan berhasil diperbarui dan sistem disinkronisasi.';
  res.redirect('/admin/settings');
});

app.get('/docs', async (req, res) => {
  let userApiKey = '';
  if (req.session.userId) {
    const key = await findOne('apiKeys', { userId: req.session.userId });
    if (key) userApiKey = key.key;
  }
  res.render('docs', { userApiKey });
});

async function apiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'API key diperlukan' });
  const keyDoc = await findOne('apiKeys', { key: apiKey });
  if (!keyDoc) return res.status(401).json({ error: 'API key tidak valid' });
  req.apiUser = keyDoc.userId;
  next();
}

app.get('/api/v1/balance', apiAuth, async (req, res) => {
  const user = await findById('users', req.apiUser);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ balance: user.balance });
});

app.get('/api/v1/invoice', apiAuth, async (req, res) => {
  const settings = await getSettings();
  const amount = parseInt(req.query.amount);
  const userId = req.apiUser;
  if (!amount || isNaN(amount) || amount < settings.minDeposit) {
    return res.status(400).json({ error: `Nominal minimal Rp ${settings.minDeposit}` });
  }
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const invoices = await readDB('invoices');
    const lockedInvoices = invoices.filter(i => i.status === 'pending' || (i.status === 'paid' && new Date(i.createdAt) >= oneDayAgo));
    const usedFees = lockedInvoices.map(i => Number(i.fee)).filter(f => !isNaN(f));
    const availableFees = [];
    for (let i = 1; i <= settings.maxFee; i++) {
      if (!usedFees.includes(i)) availableFees.push(i);
    }
    if (availableFees.length === 0) {
      return res.status(503).json({ error: 'Kode unik sedang penuh, silakan coba lagi beberapa menit.' });
    }
    const fee = availableFees[Math.floor(Math.random() * availableFees.length)];
    const total = amount + fee;
    const url = `https://${settings.apiDomain}/?action=createpayment&apikey=${settings.apiKey}&username=${settings.username}&amount=${total}&token=${settings.token}`;
    const resp = await axios.get(url);
    const data = resp.data;
    if (!data.status) throw new Error('Gagal membuat pembayaran');
    const expiredAt = new Date(Date.now() + 10 * 60 * 1000);
    const invoice = await createWithRetry('invoices', {
      _id: generateCustomId(startId.invoice),
      userId, amount, fee, total,
      trxid: data.result.trxid,
      qris_image: data.result.qris_image,
      expiredAt,
      status: 'pending',
      mutationId: null,
      createdAt: new Date()
    });
    await createWithRetry('transactions', {
      _id: generateCustomId(startId.transaction),
      userId, type: 'deposit', amount, fee,
      status: 'pending',
      reference: invoice._id.toString(),
      expiredAt,
      createdAt: new Date()
    });
    return res.json({
      success: true,
      invoice_id: invoice._id,
      amount: invoice.amount,
      fee: invoice.fee,
      total: invoice.total,
      qris_image: invoice.qris_image,
      expired_at: invoice.expiredAt
    });
  } catch (e) {
    console.error('API create invoice error:', e.response?.data || e.message);
    return res.status(500).json({ error: 'Gagal membuat invoice' });
  }
});

app.get('/api/v1/invoice/status', apiAuth, async (req, res) => {
  const invoiceId = req.query.id || req.query.invoice_id;
  if (!invoiceId) return res.status(400).json({ error: 'Invoice ID diperlukan' });
  const invoice = await findById('invoices', invoiceId);
  if (!invoice || invoice.userId !== req.apiUser) {
    return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  }
  res.json({
    invoice_id: invoice._id,
    amount: invoice.amount,
    fee: invoice.fee,
    total: invoice.total,
    status: invoice.status,
    qris_image: invoice.qris_image,
    expired_at: invoice.expiredAt,
    created_at: invoice.createdAt
  });
});

app.get('/admin/backup', isAuth, isAdmin, async (req, res) => {
  const settings = await getSettings();
  const hasTelegram = !!(settings.telegramBotToken && settings.telegramAdminChatId);
  res.render('admin_backup', { hasTelegram, settings });
});

app.post('/admin/backup/create', isAuth, isAdmin, async (req, res) => {
  try {
    const { backupType } = req.body;
    const result = await performBackup(backupType || 'database');
    
    if (result.success) {
      req.session.successMsg = `Backup berhasil dibuat! File: ${result.fileName}`;
    } else {
      req.session.errorMsg = `Backup gagal: ${result.error}`;
    }
  } catch (error) {
    req.session.errorMsg = `Backup gagal: ${error.message}`;
  }
  
  res.redirect('/admin/backup');
});

// ===================== OTP SERVICE ROUTES =====================
// ===================== OTP SERVICE ROUTES =====================
app.get('/otp', isAuth, async (req, res) => {
  try {
    console.log('[DEBUG] Loading OTP dashboard...');
    const servicesResult = await getRumahOTPServices();
    const orders = await getOTPOrders(req.session.userId);
    const user = res.locals.user;
    
    res.render('dashboard_otp', {
      services: servicesResult.success ? servicesResult.data : [],
      servicesError: servicesResult.error,
      orders: orders.slice(0, 5),
      user: user,
      adminFee: OTP_ADMIN_FEE
    });
  } catch (error) {
    console.error('[ERROR] OTP dashboard error:', error);
    req.session.errorMsg = 'Gagal memuat halaman OTP';
    res.redirect('/dashboard');
  }
});

app.get('/otp/countries', isAuth, async (req, res) => {
  try {
    const { service_id, service_name, service_img } = req.query;
    console.log('[DEBUG] Fetching countries for service:', service_id);
    
    const countries = await getRumahOTPCountries(service_id);
    
    res.render('negara_otp', {
      serviceId: service_id,
      serviceName: service_name || 'Unknown',
      serviceImg: service_img || '',
      countries: countries.success ? countries.data : [],
      user: res.locals.user,
      adminFee: OTP_ADMIN_FEE
    });
  } catch (error) {
    console.error('[ERROR] Countries page error:', error);
    req.session.errorMsg = 'Gagal memuat daftar negara';
    res.redirect('/otp');
  }
});

app.get('/otp/operators', isAuth, async (req, res) => {
  try {
    const { 
      country_id, 
      country_name, 
      country_price, 
      provider_id, 
      service_id, 
      service_name, 
      service_img,
      server_id, 
      rate, 
      stock
    } = req.query;
    
    console.log('[DEBUG] Operator page - country_price:', country_price, 'type:', typeof country_price);
    
    const operators = await getRumahOTPOperators(country_name, provider_id);
    
    res.render('operator_otp', {
      serviceId: service_id,
      serviceName: service_name || 'Unknown',
      serviceImg: service_img || '',
      countryId: country_id,
      countryName: country_name || 'Unknown',
      countryPrice: country_price || '0',
      providerId: provider_id,
      serverId: server_id || '1',
      rate: rate || 0,
      stock: stock || 0,
      operators: operators.success ? operators.data : [],
      user: res.locals.user,
      adminFee: OTP_ADMIN_FEE
    });
  } catch (error) {
    console.error('[ERROR] Operators page error:', error);
    req.session.errorMsg = 'Gagal memuat daftar operator';
    res.redirect('/otp');
  }
});

app.post('/otp/order', isAuth, async (req, res) => {
  try {
    const { 
      service_id, service_name, service_img, 
      country_id, country_name, country_price, 
      provider_id, operator_id, operator_name 
    } = req.body;
    
    console.log('[DEBUG] Order request - country_price:', country_price, 'operator_id:', operator_id);
    
    const user = res.locals.user;
    const basePrice = parseInt(country_price) || 0;
    const totalPrice = basePrice + OTP_ADMIN_FEE;
    
    console.log('[DEBUG] basePrice:', basePrice, 'totalPrice:', totalPrice, 'userBalance:', user.balance);
    
    if (user.balance < totalPrice) {
      req.session.errorMsg = `Saldo tidak cukup! Total: Rp ${totalPrice.toLocaleString()}`;
      return res.redirect(`/otp/operators?country_id=${country_id}&country_name=${encodeURIComponent(country_name)}&country_price=${basePrice}&provider_id=${provider_id}&service_id=${service_id}&service_name=${encodeURIComponent(service_name)}&service_img=${encodeURIComponent(service_img || '')}`);
    }
    
    const orderResult = await orderRumahOTPNumber(country_id, provider_id, operator_id);
    
    if (!orderResult.success) {
      if (orderResult.error && orderResult.error.toLowerCase().includes('stock')) {
        req.session.errorMsg = 'Stock habis, silakan pilih server lain';
        return res.redirect(`/otp/countries?service_id=${service_id}&service_name=${encodeURIComponent(service_name)}&service_img=${encodeURIComponent(service_img || '')}`);
      }
      throw new Error(orderResult.error || 'Gagal order');
    }
    
    user.balance -= totalPrice;
    await updateById('users', user._id, { $set: user });
    
    const newOrder = {
      _id: generateCustomId('OTP'),
      userId: user._id,
      serviceName: service_name,
      serviceImg: service_img,
      countryName: country_name,
      countryId: country_id,
      providerId: provider_id,
      serverId: operator_id,
      operatorName: operator_name,
      phoneNumber: orderResult.data.phone_number,
      orderId: orderResult.data.order_id,
      price: basePrice,
      adminFee: OTP_ADMIN_FEE,
      totalPrice: totalPrice,
      status: 'waiting',
      createdAt: new Date(),
      expiredAt: orderResult.data.expired_at ? new Date(orderResult.data.expired_at) : new Date(Date.now() + 10 * 60000)
    };
    
    await saveOTPOrder(newOrder);
    
    await sendAdminNotification('new_otp_order', { 
      username: user.username, 
      service: service_name, 
      country: country_name, 
      operator: operator_name, 
      price: totalPrice 
    });
    
    res.redirect(`/otp/order/${newOrder._id}`);
    
  } catch (error) {
    console.error('[ERROR] Order error:', error);
    req.session.errorMsg = error.message || 'Gagal memesan OTP';
    res.redirect('/otp');
  }
});

app.get('/otp/order/:id', isAuth, async (req, res) => {
  try {
    let order = (await getOTPOrders()).find(o => o._id === req.params.id);
    if (!order || order.userId !== req.session.userId) {
      req.session.errorMsg = 'Order tidak ditemukan';
      return res.redirect('/otp');
    }
    
    if (order.status === 'waiting' && order.orderId) {
      const statusResult = await checkRumahOTPStatus(order.orderId);
      if (statusResult.success && statusResult.data) {
        if (statusResult.data.status === 'completed' && statusResult.data.otp_code) {
          order.otpCode = statusResult.data.otp_code;
          order.otpMessage = statusResult.data.otp_msg;
          order.status = 'success';
          await updateOTPOrder(order._id, { 
            otpCode: statusResult.data.otp_code, 
            otpMessage: statusResult.data.otp_msg, 
            status: 'success' 
          });
        } else if (statusResult.data.status === 'expired' || statusResult.data.status === 'canceled') {
          order.status = 'expired';
          await updateOTPOrder(order._id, { status: 'expired' });
          const user = await findById('users', order.userId);
          if (user) { 
            user.balance += order.totalPrice; 
            await updateById('users', user._id, { $set: user }); 
          }
        }
      }
      if (new Date() > new Date(order.expiredAt) && order.status === 'waiting') {
        order.status = 'expired';
        await updateOTPOrder(order._id, { status: 'expired' });
        const user = await findById('users', order.userId);
        if (user) { 
          user.balance += order.totalPrice; 
          await updateById('users', user._id, { $set: user }); 
        }
      }
    }
    res.render('order_otp', { order, user: res.locals.user });
  } catch (error) {
    console.error('[ERROR] Order detail error:', error);
    req.session.errorMsg = 'Gagal memuat detail order';
    res.redirect('/otp');
  }
});

// Route /otp/api/check/:id - PERBAIKI deteksi status
app.get('/otp/api/check/:id', isAuth, async (req, res) => {
  try {
    const orders = await getOTPOrders();
    const order = orders.find(o => o._id === req.params.id);
    if (!order || order.userId !== req.session.userId) {
      return res.json({ success: false, message: 'Order tidak ditemukan' });
    }
    
    let updated = false;
    let newStatus = order.status;
    
    if (order.status === 'waiting' && order.orderId) {
      console.log(`[API] Checking order ${order.orderId} from RumahOTP...`);
      const statusResult = await checkRumahOTPStatus(order.orderId);
      console.log(`[API] Status result:`, JSON.stringify(statusResult));
      
      if (statusResult.success && statusResult.data) {
        const apiStatus = statusResult.data.status;
        const otpCode = statusResult.data.otp_code;
        
        // PERBAIKAN: Deteksi jika status 'received' ATAU 'completed' dan ada OTP code
        if ((apiStatus === 'received' || apiStatus === 'completed') && otpCode) {
          console.log(`[API] OTP FOUND! Status: ${apiStatus}, Code: ${otpCode}`);
          await updateOTPOrder(order._id, { 
            otpCode: otpCode, 
            otpMessage: statusResult.data.otp_msg, 
            status: 'success' 
          });
          newStatus = 'success';
          updated = true;
          
          // Kirim notifikasi ke admin via Telegram
          const user = await findById('users', order.userId);
          const adminChatId = await getAdminChatId();
          if (adminChatId && user) {
            await sendTelegramMessage(adminChatId, 
              `OTP BERHASIL DITERIMA\n\n` +
              `User: ${user.username}\n` +
              `Layanan: ${order.serviceName}\n` +
              `Negara: ${order.countryName}\n` +
              `KODE OTP: ${otpCode}\n` +
              `Pesan: ${statusResult.data.otp_msg?.substring(0, 100)}...\n` +
              `Waktu: ${new Date().toLocaleString('id-ID')}`
            );
          }
          
        } else if (apiStatus === 'expired' || apiStatus === 'canceled') {
          console.log(`[API] Order expired/canceled`);
          await updateOTPOrder(order._id, { status: 'expired' });
          newStatus = 'expired';
          updated = true;
          
          // Refund saldo
          const user = await findById('users', order.userId);
          if (user) { 
            user.balance += order.totalPrice; 
            await updateById('users', user._id, { $set: user }); 
            console.log(`[API] Refunded Rp ${order.totalPrice} to user ${user.username}`);
          }
        }
      }
    }
    
    res.json({ success: true, status: newStatus, updated: updated });
  } catch (error) {
    console.error('[ERROR] API check error:', error);
    res.json({ success: false, message: error.message });
  }
});

app.post('/otp/cancel/:id', isAuth, async (req, res) => {
  try {
    const orders = await getOTPOrders();
    const order = orders.find(o => o._id === req.params.id);
    if (!order || order.userId !== req.session.userId) {
      return res.json({ success: false, message: 'Order tidak ditemukan' });
    }
    if (order.status !== 'waiting') {
      return res.json({ success: false, message: 'Order tidak dapat dibatalkan' });
    }
    
    await cancelRumahOTPOrder(order.orderId);
    const user = await findById('users', order.userId);
    if (user) { 
      user.balance += order.totalPrice; 
      await updateById('users', user._id, { $set: user }); 
    }
    await updateOTPOrder(order._id, { status: 'cancelled' });
    res.json({ success: true, message: 'Order dibatalkan, saldo dikembalikan' });
  } catch (error) {
    console.error('[ERROR] Cancel order error:', error);
    res.json({ success: false, message: 'Gagal membatalkan order' });
  }
});

// ===================== OTP HISTORY ROUTE =====================
app.get('/otp/history', isAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 15;
    const filter = req.query.filter || 'all';
    const search = req.query.search || '';
    
    let orders = await getOTPOrders(req.session.userId);
    
    // Filter berdasarkan status
    if (filter !== 'all') {
      orders = orders.filter(o => o.status === filter);
    }
    
    // Filter berdasarkan pencarian
    if (search) {
      const searchLower = search.toLowerCase();
      orders = orders.filter(o => 
        o._id.toLowerCase().includes(searchLower) || 
        o.serviceName.toLowerCase().includes(searchLower) ||
        o.countryName.toLowerCase().includes(searchLower)
      );
    }
    
    const totalOrders = orders.length;
    const totalPages = Math.ceil(totalOrders / limit);
    const startIndex = (page - 1) * limit;
    const paginatedOrders = orders.slice(startIndex, startIndex + limit);
    
    // Statistik
    const successCount = orders.filter(o => o.status === 'success').length;
    const waitingCount = orders.filter(o => o.status === 'waiting').length;
    const expiredCount = orders.filter(o => o.status === 'expired').length;
    
    res.render('otp_history', {
      orders: paginatedOrders,
      totalOrders: totalOrders,
      successCount: successCount,
      waitingCount: waitingCount,
      expiredCount: expiredCount,
      currentPage: page,
      totalPages: totalPages,
      limit: limit,
      filter: filter,
      search: search,
      user: res.locals.user
    });
  } catch (error) {
    console.error('[ERROR] OTP history error:', error);
    req.session.errorMsg = 'Gagal memuat riwayat pesanan';
    res.redirect('/otp');
  }
});

// ===================== ADMIN OTP ROUTE =====================
app.get('/admin/otp', isAuth, isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const filter = req.query.filter || 'all';
    const search = req.query.search || '';
    
    let orders = await getOTPOrders();
    
    // Ambil data user untuk setiap order
    const users = await readDB('users');
    orders = orders.map(order => {
      const user = users.find(u => u._id === order.userId);
      return {
        ...order,
        username: user?.username || 'Unknown',
        userEmail: user?.email || '-'
      };
    });
    
    // Filter berdasarkan status
    if (filter !== 'all') {
      orders = orders.filter(o => o.status === filter);
    }
    
    // Filter berdasarkan pencarian
    if (search) {
      const searchLower = search.toLowerCase();
      orders = orders.filter(o => 
        o._id.toLowerCase().includes(searchLower) ||
        o.serviceName.toLowerCase().includes(searchLower) ||
        o.countryName.toLowerCase().includes(searchLower) ||
        o.username?.toLowerCase().includes(searchLower) ||
        o.userEmail?.toLowerCase().includes(searchLower)
      );
    }
    
    // Statistik
    const totalOrders = orders.length;
    
    // PENDAPATAN KOTOR (Harga Nomor + Fee Admin)
    const totalGrossRevenue = orders
      .filter(o => o.status === 'success')
      .reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    
    // KEUNTUNGAN BERSIH (Hanya Fee Admin)
    const totalNetRevenue = orders
      .filter(o => o.status === 'success')
      .reduce((sum, o) => sum + (o.adminFee || 0), 0);
    
    const successCount = orders.filter(o => o.status === 'success').length;
    const waitingCount = orders.filter(o => o.status === 'waiting').length;
    const expiredCount = orders.filter(o => o.status === 'expired').length;
    
    // Ambil saldo provider RumahOTP
    const providerBalance = await getRumahOTPBalance();
    
    // Pagination
    const totalPages = Math.ceil(totalOrders / limit);
    const startIndex = (page - 1) * limit;
    const paginatedOrders = orders.slice(startIndex, startIndex + limit);
    
    res.render('admin_otp', {
      orders: paginatedOrders,
      stats: {
        totalOrders: totalOrders,
        totalGrossRevenue: totalGrossRevenue,
        totalNetRevenue: totalNetRevenue,
        successCount: successCount,
        waitingCount: waitingCount,
        expiredCount: expiredCount
      },
      providerBalance: providerBalance.success ? providerBalance.data : null,
      providerBalanceError: providerBalance.error,
      currentPage: page,
      totalPages: totalPages,
      limit: limit,
      filter: filter,
      search: search,
      totalOrders: totalOrders,
      adminFee: OTP_ADMIN_FEE,
      user: res.locals.user
    });
  } catch (error) {
    console.error('[ERROR] Admin OTP error:', error);
    req.session.errorMsg = 'Gagal memuat data OTP';
    res.redirect('/admin/dashboard');
  }
});

// ===================== SEO ROUTES =====================
// Sitemap
app.get('/sitemap.xml', async (req, res) => {
  const sitemapPath = path.join(__dirname, 'public', 'sitemap.xml');
  res.sendFile(sitemapPath);
});

// Robots.txt
app.get('/robots.txt', async (req, res) => {
  const robotsPath = path.join(__dirname, 'public', 'robots.txt');
  res.sendFile(robotsPath);
});

// ===================== NOTIFICATION ROUTES =====================
// Admin: Get all notifications
app.get('/admin/notifications', isAuth, isAdmin, async (req, res) => {
  const notifications = await getNotifications();
  res.render('admin_notifications', { notifications, user: res.locals.user });
});

// Admin: Create notification
app.post('/admin/notifications/create', isAuth, isAdmin, async (req, res) => {
  const { title, message, imageUrl, target, displayType } = req.body;
  
  const newNotif = {
    _id: generateCustomId('NOTIF'),
    title: title || 'Pengumuman',
    message: message || '',
    imageUrl: imageUrl || null,
    target: target || 'all',
    displayType: displayType || 'once',
    isActive: true,
    seenBy: [],
    createdAt: new Date(),
    updatedAt: new Date()
  };
  
  await saveNotification(newNotif);
  req.session.successMsg = 'Notifikasi berhasil dibuat!';
  res.redirect('/admin/notifications');
});

// Admin: Update notification
app.post('/admin/notifications/update/:id', isAuth, isAdmin, async (req, res) => {
  const { title, message, imageUrl, target, displayType, isActive } = req.body;
  await updateNotification(req.params.id, {
    title,
    message,
    imageUrl,
    target,
    displayType,
    isActive: isActive === 'on',
    updatedAt: new Date()
  });
  req.session.successMsg = 'Notifikasi berhasil diperbarui!';
  res.redirect('/admin/notifications');
});

// Admin: Delete notification
app.post('/admin/notifications/delete/:id', isAuth, isAdmin, async (req, res) => {
  await deleteNotification(req.params.id);
  req.session.successMsg = 'Notifikasi berhasil dihapus!';
  res.redirect('/admin/notifications');
});

// User: Get active notifications (API)
app.get('/api/notifications/active', isAuth, async (req, res) => {
  const notifications = await getNotifications();
  const userNotifs = notifications.filter(n => {
    if (!n.isActive) return false;
    if (n.target !== 'all' && n.target !== req.session.userId) return false;
    if (n.displayType === 'once' && n.seenBy && n.seenBy.includes(req.session.userId)) return false;
    return true;
  });
  res.json({ success: true, notifications: userNotifs });
});

// User: Mark notification as seen
app.post('/api/notifications/seen/:id', isAuth, async (req, res) => {
  await markNotificationAsSeen(req.params.id, req.session.userId);
  res.json({ success: true });
});

let checkerInterval;
async function checkMutasi() {
  try {
    const settings = await getSettings();
    if (!settings.autoCheckEnabled || !settings.apiKey) return;
    
    let invoices = await readDB('invoices');
    const pendingInvoices = invoices.filter(i => i.status === 'pending');
    const now = new Date();
    
    for (const inv of pendingInvoices) {
      if (now > new Date(inv.expiredAt)) {
        inv.status = 'expired';
        await updateById('invoices', inv._id, { $set: inv });
        
        const transactions = await readDB('transactions');
        const tx = transactions.find(t => t.reference === inv._id.toString() && t.type === 'deposit' && t.status === 'pending');
        if (tx) {
          tx.status = 'expired';
          await updateById('transactions', tx._id, { $set: tx });
        }
      }
    }
    
    invoices = await readDB('invoices');
    
    // PERBAIKAN: Gunakan parameter yang benar
    const mutasiUrl = `https://${settings.apiDomain}/?action=mutasiqr&apikey=${settings.apiKey}&username=${settings.username}&token=${settings.token}`;
    
    console.log('[DEBUG] Mutasi URL:', mutasiUrl.replace(settings.apiKey, 'HIDDEN'));
    
    const resp = await axios.get(mutasiUrl);
    const data = resp.data;
    
    console.log('[DEBUG] Mutasi response:', JSON.stringify(data).substring(0, 500));
    
    if (!data.status || !data.result || !data.result.success || !Array.isArray(data.result.results)) return;
    
    const results = data.result.results;
    const usedMutationIds = invoices.filter(i => i.mutationId !== null).map(i => String(i.mutationId));
    const availableMutations = results.filter(tx => tx.status === 'IN' && !usedMutationIds.includes(String(tx.id)));
    
    for (const inv of invoices) {
      if (inv.status !== 'pending') continue;
      
      const matchedMutation = availableMutations.find(tx => {
        const nominal = parseInt(String(tx.kredit).replace(/\./g, ''));
        if (nominal !== inv.total) return false;
        
        const rawDateString = tx.tanggal || tx.created_at || tx.createdAt || tx.date || tx.datetime;
        if (!rawDateString) return false;
        
        let mutationTime;
        if (rawDateString.includes('/')) {
          const [datePart, timePart] = rawDateString.split(' ');
          const [day, month, year] = datePart.split('/');
          mutationTime = new Date(`${year}-${month}-${day}T${timePart}+07:00`);
        } else {
          mutationTime = new Date(rawDateString);
        }
        
        if (isNaN(mutationTime.getTime())) return false;
        const diffMinutes = Math.abs(mutationTime.getTime() - new Date(inv.createdAt).getTime()) / 1000 / 60;
        return diffMinutes <= 30;
      });
      
      if (!matchedMutation) continue;
      
      inv.status = 'paid';
      inv.mutationId = String(matchedMutation.id);
      await updateById('invoices', inv._id, { $set: inv });
      
      const user = await findById('users', inv.userId);
      if (user) {
        user.balance = (user.balance || 0) + inv.amount;
        await updateById('users', inv.userId, { $set: user });
      }
      
      const transactions = await readDB('transactions');
      const tx = transactions.find(t => t.reference === inv._id.toString() && t.type === 'deposit' && t.status === 'pending');
      if (tx) {
        tx.status = 'paid';
        await updateById('transactions', tx._id, { $set: tx });
      }
      
      await updateOne('stats', {}, { $inc: { totalDepositAmount: inv.amount, totalDepositFee: inv.fee, totalTransactions: 1 } });
      
      const index = availableMutations.findIndex(tx => String(tx.id) === String(matchedMutation.id));
      if (index !== -1) availableMutations.splice(index, 1);
      
      const adminChatId = await getAdminChatId();
      if (adminChatId && user) {
        const timeString = new Date().toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const message = `🌐 *Notifikasi - ${settings.name}*\n\n👤 *Informasi User*\n• User: ${user.username} (${user.email})\n• Saldo Saat Ini: Rp ${user.balance.toLocaleString('id-ID')}\n\n💰 *Informasi Deposit*\n• Jumlah: Rp ${inv.amount.toLocaleString('id-ID')}\n• Fee: Rp ${inv.fee.toLocaleString('id-ID')}\n• Total: Rp ${inv.total.toLocaleString('id-ID')}\n• ID Invoice: ${inv._id}\n• Waktu: ${timeString}\n• Status: Paid`;
        await sendTelegramMessage(adminChatId, message);
      }
    }
  } catch (err) {
    console.error('Mutasi error:', err.response?.data || err.message);
  }
}

async function updateStatsOnStartup() {
  const transactions = await readDB('transactions');
  
  const depositPaid = transactions.filter(t => t.type === 'deposit' && t.status === 'paid');
  const withdrawSuccess = transactions.filter(t => t.type === 'withdraw' && t.status === 'success');
  
  const dAmount = depositPaid.reduce((sum, t) => sum + (t.amount || 0), 0);
  const dFee = depositPaid.reduce((sum, t) => sum + (t.fee || 0), 0);
  const wAmount = withdrawSuccess.reduce((sum, t) => sum + (t.amount || 0), 0);
  const wFee = withdrawSuccess.reduce((sum, t) => sum + (t.fee || 0), 0);
  const totalUsers = await countDocuments('users', { role: 'user' });
  const totalTransactions = transactions.length;
  
  const stats = await findOne('stats', {});
  if (stats) {
    stats.totalDepositAmount = dAmount;
    stats.totalDepositFee = dFee;
    stats.totalWithdrawAmount = wAmount;
    stats.totalWithdrawFee = wFee;
    stats.totalUsers = totalUsers;
    stats.totalTransactions = totalTransactions;
    await updateById('stats', stats._id, { $set: stats });
  } else {
    await insertOne('stats', {
      _id: 'stats_1',
      totalDepositAmount: dAmount,
      totalDepositFee: dFee,
      totalWithdrawAmount: wAmount,
      totalWithdrawFee: wFee,
      totalUsers,
      totalTransactions
    });
  }
}

function startChecker() {
  if (checkerInterval) clearInterval(checkerInterval);
  getSettings().then(s => {
    if (s.autoCheckEnabled) {
      checkerInterval = setInterval(checkMutasi, s.checkInterval * 1000);
      checkMutasi();
    }
  });
}

setTimeout(async () => {
  await seed();
  await updateStatsOnStartup();
  startChecker();
  startTelegramPolling();
  scheduleAutoBackup();
  scheduleAutoRestart();
}, 2000);

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));





