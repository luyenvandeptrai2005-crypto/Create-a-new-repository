require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    CHECK_INTERVAL: 15000,
    RETRY_COUNT: 3
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./uid_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });
const userSessions = new Map();

// ================= DATABASE =================
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            name TEXT DEFAULT 'Chưa xác định',
            note TEXT DEFAULT '🦦',
            status TEXT DEFAULT 'LIVE',
            die_type TEXT DEFAULT '',
            is_tracking INTEGER DEFAULT 1,
            fail_count INTEGER DEFAULT 0,
            created_at TEXT
        )
    `);
});

// ================= HELPERS =================
const formatTime = () => {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

const extractUID = (input) => {
    const match = input.trim().match(/(\d{5,20})/);
    return match ? match[1] : null;
};

// Hàm bắt dạng DIE từ URL redirect
const detectDieType = (url, html) => {
    if (!url) return 'Không rõ';
    const checkpointMatch = url.match(/checkpoint\/(\d+)/);
    if (checkpointMatch) {
        const id = checkpointMatch[1];
        if (id.endsWith('282')) return '282';
        if (id.endsWith('956')) return '956';
        return id; 
    }
    const helpMatch = url.match(/help\/(?:contact\/)?(\d+)/);
    if (helpMatch) {
        const id = helpMatch[1];
        if (id.endsWith('583')) return '583';
        return id;
    }
    return 'Không rõ';
};

// ================= CORE CHECKER =================
async function smartCheck(uid) {
    try {
        const res = await axios.get(`https://mbasic.facebook.com/${uid}`, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept-language': 'vi-VN,vi;q=0.9'
            },
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const location = res.headers.location || '';
        const html = String(res.data).toLowerCase();

        if (location.includes('login.php')) return { status: 'COOKIE_DIE' };
        if (location.includes('checkpoint') || location.includes('help') || location.includes('recover')) {
            return { status: 'DIE', dieType: detectDieType(location, html) };
        }
        
        const dieKeywords = ["nội dung này hiện không khả dụng", "không tìm thấy nội dung", "this content isn't available"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
            return { status: 'DIE', dieType: '583 / 404' };
        }

        return { status: 'LIVE' };
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= UI MENU (CHUẨN ẢNH 2) =================
const sendHelpMenu = (chatId) => {
    const menu = `📂 *Các lệnh có sẵn:*

🔵 *Facebook:*
/check - Check Profile Facebook
/checkgroup - Check Group Facebook
/checkpost - Check Post/Ảnh bài viết Facebook
/addacc - Thêm tài khoản Facebook
/listacc - Danh sách tài khoản đã thêm
/listmonitor - Xem danh sách theo dõi UID
/deleteacc - Xóa UID

🔴 *TikTok:*
/checktt - Check TikTok
/listtt - Xem danh sách TikTok
/deletett [ID/Username] - Xóa TikTok

🎁 *Tiện ích:*
/search [Từ khóa] - Tìm UID (Theo UID/Note của FB & TikTok)
/update - Nâng cấp gói VIP
/mybot - Quản lý bot con

ℹ️ *Khác:*
/news - Xem thông báo
/info - Xem thông tin tài khoản
/menu - Hiển thị menu
/help - Xem hướng dẫn sử dụng chi tiết

💡 *Ví dụ sử dụng:*
/add 100012345678 | Chính chủ | Ghi chú | 200000 | 1d
/edit 100012345678 | Ghi chú | 300000 | 2d`;

    bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
};

bot.onText(/\/start|\/menu|\/help/, (msg) => {
    userSessions.delete(msg.chat.id);
    sendHelpMenu(msg.chat.id);
});

bot.onText(/\/check/, (msg) => {
    userSessions.set(msg.chat.id, { state: 'AWAITING_UID' });
    bot.sendMessage(msg.chat.id, '📩 Vui lòng nhập UID Hoặc URL:');
});

// ================= HANDLING MESSAGES =================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);

    // Luồng Check UID
    if (session && session.state === 'AWAITING_UID') {
        const uid = extractUID(msg.text);
        if (!uid) return bot.sendMessage(chatId, '❌ Lỗi: UID không hợp lệ.');

        bot.sendMessage(chatId, `⏳ Đang kiểm tra UID: ${uid}...`);
        const result = await smartCheck(uid);

        if (result.status === 'LIVE') {
            bot.sendMessage(chatId, `✅ UID của bạn là: \`${uid}\` đang LIVE.`);
            userSessions.delete(chatId);
        } else if (result.status === 'DIE') {
            // Giao diện y hệt ảnh 1
            const text = `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${result.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
            bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: 'ignore' }],
                        [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]
                    ]
                }
            });
        }
    } 
    // Luồng Nhập Tên Tài Khoản khi Lưu
    else if (session && session.state === 'AWAITING_NAME') {
        const uid = session.tempUid;
        db.run(`INSERT OR REPLACE INTO accounts (uid, chat_id, name, created_at) VALUES (?, ?, ?, ?)`, 
        [uid, chatId, msg.text, new Date().toISOString()], (err) => {
            if (!err) bot.sendMessage(chatId, `✅ Đã thêm UID ${uid} vào danh sách theo dõi biến động.`);
            userSessions.delete(chatId);
        });
    }
});

// ================= CALLBACK QUERIES =================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data.startsWith('save_')) {
        const uid = data.replace('save_', '');
        userSessions.set(chatId, { state: 'AWAITING_NAME', tempUid: uid });
        bot.sendMessage(chatId, '👤 Vui lòng nhập *Tên Tài Khoản* để theo dõi:', { parse_mode: 'Markdown' });
    } 
    else if (data.startsWith('pause_')) {
        const uid = data.replace('pause_', '');
        db.run(`UPDATE accounts SET is_tracking = 0 WHERE uid = ?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🛑 Đã dừng theo dõi' });
    }
    else if (data.startsWith('resume_')) {
        const uid = data.replace('resume_', '');
        db.run(`UPDATE accounts SET is_tracking = 1 WHERE uid = ?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '▶️ Đã tiếp tục theo dõi' });
    }
    else if (data.startsWith('delete_')) {
        const uid = data.replace('delete_', '');
        db.run(`DELETE FROM accounts WHERE uid=?`, [uid]);
        bot.deleteMessage(chatId, query.message.message_id);
    }
    bot.answerCallbackQuery(query.id);
});

// ================= AUTO MONITOR (THEO DÕI BIẾN ĐỘNG) =================
cron.schedule('*/1 * * * *', async () => {
    db.all(`SELECT * FROM accounts WHERE is_tracking = 1`, async (err, rows) => {
        if (!rows) return;
        for (const row of rows) {
            await queue.add(async () => {
                const res = await smartCheck(row.uid);
                if (res.status === 'ERROR' || res.status === 'COOKIE_DIE') return;

                // Nếu từ LIVE sang DIE (Giống ảnh 1)
                if (res.status === 'DIE' && row.status === 'LIVE') {
                    const failCount = row.fail_count + 1;
                    if (failCount >= 3) {
                        const text = `🍂 \`${row.uid}\` đã DIE ❌\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${formatTime()}`;
                        bot.sendMessage(row.chat_id, text, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                                ]
                            }
                        });
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0 WHERE uid=?`, [res.dieType, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=? WHERE uid=?`, [failCount, row.uid]);
                    }
                } 
                // Nếu từ DIE sang LIVE
                else if (res.status === 'LIVE' && row.status === 'DIE') {
                    const text = `✅ *THÔNG BÁO: UID ĐÃ SỐNG LẠI*\n\n🆔 UID: \`${row.uid}\`\n👤 Tài Khoản: ${row.name}\n🌿 Trạng thái: LIVE\n⏰ Lúc: ${formatTime()}`;
                    bot.sendMessage(row.chat_id, text, { parse_mode: 'Markdown' });
                    db.run(`UPDATE accounts SET status='LIVE', fail_count=0 WHERE uid=?`, [row.uid]);
                }
            });
        }
    });
});

// ================= WEB SERVER =================
const app = express();
app.get('/', (req, res) => res.send('Bot Online'));
app.listen(process.env.PORT || 3000);
