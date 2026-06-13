require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {}; 

let FB_COOKIE = process.env.FB_COOKIE || "";
let FB_TOKEN = process.env.FB_TOKEN || "";

// ==========================================
// 1. DATABASE SQLITE
// ==========================================
const db = new sqlite3.Database('./bot_data_v2.sqlite', (err) => {
    if (err) console.error('Lỗi mở database:', err.message);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS uids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT,
            uid TEXT,
            link TEXT,
            fb_name TEXT,
            note TEXT,
            price INTEGER,
            status TEXT,
            tracking_status INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_check DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('✅ Đã kết nối Database SQLite.');
    }
});

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================
const getVNTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const formatMoney = (amount) => amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " VNĐ";

async function checkFacebookUID(uid) {
    let result = { uid: uid, status: 'DIE', fb_name: 'Không xác định' };
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...(FB_COOKIE && { 'Cookie': FB_COOKIE })
        };
        const response = await axios.get(`https://www.facebook.com/profile.php?id=${uid}`, { headers, validateStatus: () => true });
        const html = response.data;
        if (response.status === 404 || html.includes("Trang này không khả dụng") || html.includes("This page isn't available") || html.includes("checkpoint")) {
            return { uid: uid, status: 'DIE', fb_name: 'Không xác định' };
        }
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        if (titleMatch && titleMatch[1]) {
            let name = titleMatch[1].replace(' | Facebook', '').trim();
            if(name !== 'Facebook') result.fb_name = name;
        }
        result.status = 'LIVE';
        return result;
    } catch (error) { return result; }
}

function extractUID(input) {
    const match = input.match(/(?:uid=|id=|share\/|profile\.php\?id=)(\d+)/) || input.match(/^\d+$/);
    return match ? match[1] : input.trim();
}

// ==========================================
// 3. MENU COMMANDS
// ==========================================
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name;

    db.get(`SELECT COUNT(*) as count FROM uids WHERE chat_id = ?`, [chatId], (err, row) => {
        const count = row ? row.count : 0;
        const menuText = `🖥 *BẢNG ĐIỀU KHIỂN TRUNG TÂM*\n👤 Khách hàng: ${userName}\n🆔 ID Hệ thống: ${chatId}\n💎 Gói dịch vụ: 👑 *PREMIUM (Cần nạp thêm ngày)*\n\n📊 *TÀI NGUYÊN ĐANG CHẠY*\n• Facebook Monitor: ${count} mục tiêu\n• TikTok Monitor: 0 mục tiêu\n• Tổng cộng: ${count} mục tiêu\n⏳ Tự động làm sạch dữ liệu: 5 ngày/lần\n\n📜 *DANH SÁCH LỆNH HỖ TRỢ*\n🔑 *KHO TOKEN FB:* Đang hoạt động 🟢`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '🌐 Facebook Monitor', callback_data: 'menu_fb_list' }, { text: '🎵 TikTok Monitor', callback_data: 'menu_tt_list' }],
                [{ text: '💳 Nạp Tiền / Gia Hạn', callback_data: 'menu_recharge' }, { text: '🔑 Lấy Token FB', callback_data: 'menu_get_token' }],
                [{ text: '👤 Hồ Sơ Của Tôi', callback_data: 'menu_profile' }],
                [{ text: '📩 Gửi Yêu Cầu Hỗ Trợ', callback_data: 'menu_support' }]
            ]
        };
        bot.sendMessage(chatId, menuText, { parse_mode: "Markdown", reply_markup: keyboard });
    });
});

bot.onText(/\/add$/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { step: 'WAITING_LINK' };
    bot.sendMessage(chatId, "➕ *THÊM TÀI NGUYÊN MỚI*\nVui lòng gửi Link Facebook hoặc UID cần theo dõi.", { reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } });
});

// ==========================================
// 4. MESSAGE HANDLING (ADD FLOW)
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return; 

    const state = userState[chatId];
    if (!state) return;

    if (state.step === 'WAITING_LINK') {
        state.uid = extractUID(text);
        state.link = text;
        state.step = 'WAITING_NOTE';
        bot.sendMessage(chatId, `✅ Đã nhận: \`${state.uid}\`\n\n📝 Vui lòng nhập GHI CHÚ:\n_(Nhập 0 nếu không cần)_`);
    } else if (state.step === 'WAITING_NOTE') {
        state.note = text === '0' ? 'Không có' : text;
        state.step = 'WAITING_PRICE';
        bot.sendMessage(chatId, `📝 Ghi chú: ${state.note}\n\n💰 Vui lòng nhập GIÁ TIỀN (VNĐ):\n_(Nhập 0 nếu không có)_`);
    } else if (state.step === 'WAITING_PRICE') {
        state.price = text === '0' ? 0 : parseInt(text.replace(/[^0-9]/g, '')) || 0;
        bot.sendMessage(chatId, "⏳ Đang kiểm tra trạng thái Facebook...");
        const checkData = await checkFacebookUID(state.uid);
        const timeNow = getVNTime();
        db.run(`INSERT INTO uids (chat_id, uid, link, fb_name, note, price, status, created_at, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [chatId, state.uid, state.link, checkData.fb_name, state.note, state.price, checkData.status, timeNow, timeNow], () => {
            bot.sendMessage(chatId, `✅ ĐÃ LÊN ĐƠN THÀNH CÔNG\n🆔 UID: ${state.uid}\n👤 Tên: ${checkData.fb_name}\n📊 Trạng thái: ${checkData.status}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } });
            delete userState[chatId];
        });
    }
});

// ==========================================
// 5. CALLBACK QUERY (MENU & ACTIONS)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // --- MENU NAVIGATION ---
    if (data === 'back_menu') {
        delete userState[chatId];
        bot.editMessageText("🏠 Bạn đã quay lại Menu chính. Vui lòng gõ /start để tải lại.", { chat_id: chatId, message_id: messageId });
    }
    if (data === 'menu_fb_list') {
        db.all(`SELECT * FROM uids WHERE chat_id = ?`, [chatId], (err, rows) => {
            if (err || rows.length === 0) return bot.sendMessage(chatId, "📋 Danh sách trống.");
            let msgText = `📋 *DANH SÁCH FACEBOOK*\n`;
            let keyboard = [];
            rows.forEach((row, i) => {
                msgText += `${i+1}. ID: ${row.uid} | ${row.fb_name} | ${row.status}\n`;
                keyboard.push([{ text: `${i+1}`, callback_data: `list_select_${row.id}` }]);
            });
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'back_menu' }]);
            bot.editMessageText(msgText, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        });
    }
    // --- LIST ACTIONS ---
    if (data.startsWith('list_select_')) {
        const dbId = data.split('_')[2];
        bot.sendMessage(chatId, `⚙️ Tùy chọn cho ID: ${dbId}`, { reply_markup: { inline_keyboard: [[{ text: '❌ Xóa UID', callback_data: `del_uid_${dbId}` }]] } });
    }
    if (data.startsWith('del_uid_')) {
        const dbId = data.split('_')[2];
        db.run(`DELETE FROM uids WHERE id = ?`, [dbId], () => { bot.editMessageText("✅ Đã xóa!", { chat_id: chatId, message_id: messageId }); });
    }
});

// ==========================================
// 6. CRON JOBS
// ==========================================
cron.schedule('*/5 * * * *', async () => {
    db.all(`SELECT * FROM uids WHERE tracking_status = 1`, [], async (err, rows) => {
        if (err) return;
        for (const row of rows) {
            const checkData = await checkFacebookUID(row.uid);
            if (row.status === 'LIVE' && checkData.status === 'DIE') {
                bot.sendMessage(row.chat_id, `🔴 *Tài khoản DIE: ${row.uid}*`);
                db.run(`UPDATE uids SET status = 'DIE' WHERE id = ?`, [row.id]);
            }
        }
    });
});

console.log("🚀 Bot đang chạy...");
