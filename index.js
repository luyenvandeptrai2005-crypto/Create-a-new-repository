require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {}; 

let FB_COOKIE = process.env.FB_COOKIE || "";

// ==========================================
// 1. DATABASE
// ==========================================
const db = new sqlite3.Database('./bot_data_v2.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS uids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        uid TEXT,
        link TEXT,
        fb_name TEXT,
        avatar TEXT,
        note TEXT,
        price INTEGER,
        status TEXT,
        tracking_status INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_check DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================
const getVNTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const formatMoney = (amount) => amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " VNĐ";

async function checkFacebookUID(uid) {
    let result = { uid: uid, status: 'DIE', fb_name: 'Không xác định', avatar: '' };
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0',
            ...(FB_COOKIE && { 'Cookie': FB_COOKIE })
        };
        const response = await axios.get(`https://www.facebook.com/profile.php?id=${uid}`, { headers, validateStatus: () => true });
        const html = response.data;
        
        if (response.status === 404 || html.includes("Trang này không khả dụng") || html.includes("checkpoint")) return result;

        // Lấy tên
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        if (titleMatch && titleMatch[1]) result.fb_name = titleMatch[1].replace(' | Facebook', '').trim();

        // Lấy avatar
        const imageMatch = html.match(/<meta property="og:image" content="(.*?)"/);
        if (imageMatch && imageMatch[1]) result.avatar = imageMatch[1];

        result.status = 'LIVE';
        return result;
    } catch (error) { return result; }
}

function extractUID(input) {
    const match = input.match(/(?:uid=|id=|share\/|profile\.php\?id=)(\d+)/) || input.match(/^\d+$/);
    return match ? match[1] : input.trim();
}

// ==========================================
// 3. MENU & COMMANDS
// ==========================================
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id;
    db.get(`SELECT COUNT(*) as count FROM uids WHERE chat_id = ?`, [chatId], (err, row) => {
        const count = row ? row.count : 0;
        const menuText = `🖥 *BẢNG ĐIỀU KHIỂN*\n👤 Khách: ${msg.from.first_name}\n📊 Facebook Monitor: ${count} mục tiêu`;
        const keyboard = {
            inline_keyboard: [
                [{ text: '🌐 Danh sách', callback_data: 'menu_fb_list' }, { text: '➕ Thêm UID', callback_data: 'menu_add' }],
                [{ text: '🔑 Lấy Token FB', callback_data: 'menu_get_token' }]
            ]
        };
        bot.sendMessage(chatId, menuText, { parse_mode: "Markdown", reply_markup: keyboard });
    });
});

// ==========================================
// 4. ADD FLOW
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    if (data === 'menu_add') {
        userState[chatId] = { step: 'WAITING_LINK' };
        bot.sendMessage(chatId, "🔗 Gửi link hoặc UID Facebook:");
    }
    // (Thêm logic xử lý các nút khác tại đây...)
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const state = userState[chatId];
    if (!state || text.startsWith('/')) return;

    if (state.step === 'WAITING_LINK') {
        state.uid = extractUID(text);
        state.step = 'WAITING_NOTE';
        bot.sendMessage(chatId, "📝 Nhập ghi chú (hoặc 0):");
    } else if (state.step === 'WAITING_NOTE') {
        state.note = text === '0' ? 'Không có' : text;
        bot.sendMessage(chatId, "⏳ Đang kiểm tra...");
        const checkData = await checkFacebookUID(state.uid);
        db.run(`INSERT INTO uids (chat_id, uid, link, fb_name, avatar, note, status) VALUES (?,?,?,?,?,?,?)`, 
            [chatId, state.uid, text, checkData.fb_name, checkData.avatar, state.note, checkData.status]);
        
        const msgText = `✅ ĐÃ LƯU\n👤 Tên: ${checkData.fb_name}\n📊 Trạng thái: ${checkData.status}`;
        if (checkData.avatar) bot.sendPhoto(chatId, checkData.avatar, { caption: msgText });
        else bot.sendMessage(chatId, msgText);
        
        delete userState[chatId];
    }
});

// ==========================================
// 5. CRON JOB (QUÉT ĐỊNH KỲ)
// ==========================================
cron.schedule('*/5 * * * *', async () => {
    db.all(`SELECT * FROM uids WHERE tracking_status = 1`, [], async (err, rows) => {
        for (const row of rows) {
            const newData = await checkFacebookUID(row.uid);
            if (row.status === 'LIVE' && newData.status === 'DIE') {
                const alertMsg = `🔴 TÀI KHOẢN DIE!\n🆔 UID: ${row.uid}\n👤 Tên: ${row.fb_name}`;
                if (row.avatar) bot.sendPhoto(row.chat_id, row.avatar, { caption: alertMsg });
                else bot.sendMessage(row.chat_id, alertMsg);
                db.run(`UPDATE uids SET status = 'DIE' WHERE id = ?`, [row.id]);
            }
        }
    });
});

console.log("🚀 Bot đã khởi động...");
