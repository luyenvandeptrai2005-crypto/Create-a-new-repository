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

if (!CONFIG.BOT_TOKEN) {
    console.error('❌ THIẾU TELEGRAM_BOT_TOKEN');
    process.exit(1);
}

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./uid_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

// Quản lý trạng thái đàm thoại (State)
const userSessions = new Map();

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
];

// ================= DATABASE =================
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            name TEXT DEFAULT 'chưa cập nhật',
            note TEXT DEFAULT '🦦',
            status TEXT DEFAULT 'LIVE',
            die_type TEXT DEFAULT 'Không rõ',
            is_tracking INTEGER DEFAULT 1,
            fail_count INTEGER DEFAULT 0,
            created_at TEXT
        )
    `);
});

// ================= HELPER FUNCTIONS =================
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const formatTime = () => {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

const extractUID = (input) => {
    if (!input) return null;
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
    if (url.includes('/recover/')) return 'Recover';
    if (url.includes('/login/') && html.includes('tài khoản của bạn đã bị vô hiệu hóa')) return 'Disabled';
    return 'Không rõ';
};

// ================= CORE CHECKER =================
async function smartCheck(uid) {
    try {
        const res = await axios.get(`https://mbasic.facebook.com/${uid}`, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': getRandomUA(),
                'accept-language': 'vi-VN,vi;q=0.9'
            },
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const location = res.headers.location || '';
        const html = String(res.data).toLowerCase();

        // 1. Kiểm tra Cookie lỗi
        if (location.includes('login.php') && !html.includes('profile')) {
            return { status: 'COOKIE_DIE' };
        }

        // 2. Kiểm tra Redirect dính Checkpoint / Help Center
        if (location.includes('checkpoint') || location.includes('recover') || location.includes('help')) {
            const dieType = detectDieType(location, html);
            return { status: 'DIE', dieType };
        }

        // 3. Quét từ khóa DIE nội dung không khả dụng
        const dieKeywords = ["this content isn't available", "nội dung này hiện không khả dụng", "không tìm thấy nội dung", "liên kết bạn đã theo dõi có thể bị hỏng"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
            return { status: 'DIE', dieType: 'Mất liên kết / 404' };
        }

        // 4. Xác nhận LIVE thật sự
        const liveKeywords = ['timeline', 'dòng thời gian', 'add friend', 'thêm bạn', 'nhắn tin', 'message', 'photo'];
        if (liveKeywords.some(v => html.includes(v)) || html.includes(uid)) {
            return { status: 'LIVE' };
        }

        return { status: 'DIE', dieType: 'Không xác định' };
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= BOT COMMANDS & INTERFACE =================
bot.setMyCommands([
    { command: '/start', description: 'Mở Menu hệ thống' },
    { command: '/check', description: 'Vui lòng nhập UID Hoặc URL' }
]);

bot.onText(/\/start/, (msg) => {
    userSessions.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, `⚙️ *HỆ THỐNG QUẢN LÝ TÀI KHOẢN PRO*\nChọn chức năng bên dưới để bắt đầu:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Check UID Mới', callback_data: 'menu_check' }]
            ]
        }
    });
});

bot.onText(/\/check/, (msg) => {
    userSessions.set(msg.chat.id, { state: 'AWAITING_UID' });
    bot.sendMessage(msg.chat.id, '📬 Vui lòng nhập UID Hoặc URL:');
});

// ================= CALLBACK QUERIES =================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data === 'menu_check') {
        userSessions.set(chatId, { state: 'AWAITING_UID' });
        bot.sendMessage(chatId, '📬 Vui lòng nhập UID Hoặc URL:');
        bot.answerCallbackQuery(query.id);
    } 
    else if (data.startsWith('save_uid_')) {
        const uid = data.replace('save_uid_', '');
        userSessions.set(chatId, { state: 'AWAITING_ACC_NAME', tempUid: uid });
        bot.sendMessage(chatId, '📝 Vui lòng nhập Tên Tài Khoản cho UID này:', { reply_markup: { force_reply: true } });
        bot.answerCallbackQuery(query.id);
    } 
    else if (data === 'ignore_uid') {
        userSessions.delete(chatId);
        bot.deleteMessage(chatId, messageId);
        bot.answerCallbackQuery(query.id, { text: 'Đã bỏ qua.' });
    }
    else if (data.startsWith('pause_')) {
        const uid = data.replace('pause_', '');
        db.run(`UPDATE accounts SET is_tracking = 0 WHERE uid = ?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🛑 Đã dừng theo dõi' });
        
        // Đổi nút thành Tiếp tục theo dõi giống ảnh mẫu
        bot.editMessageReplyMarkup({
            inline_keyboard: [
                [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${uid}` }],
                [{ text: '❌ Xóa UID', callback_data: `delete_${uid}` }]
            ]
        }, { chat_id: chatId, message_id: messageId });
    }
    else if (data.startsWith('resume_')) {
        const uid = data.replace('resume_', '');
        db.run(`UPDATE accounts SET is_tracking = 1 WHERE uid = ?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '▶️ Đã tiếp tục theo dõi' });
        
        bot.editMessageReplyMarkup({
            inline_keyboard: [
                [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${uid}` }],
                [{ text: '❌ Xóa UID', callback_data: `delete_${uid}` }]
            ]
        }, { chat_id: chatId, message_id: messageId });
    }
    else if (data.startsWith('delete_')) {
        const uid = data.replace('delete_', '');
        db.run(`DELETE FROM accounts WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: `🗑 Đã xóa UID ${uid}` });
        bot.deleteMessage(chatId, messageId);
    }
    else if (data.startsWith('recheck_')) {
        const uid = data.replace('recheck_', '');
        bot.answerCallbackQuery(query.id, { text: '⏳ Đang kiểm tra lại...' });
        
        const result = await smartCheck(uid);
        if (result.status === 'LIVE') {
            bot.sendMessage(chatId, `✅ UID của bạn là: \`${uid}\` đang LIVE.`);
        } else {
            bot.sendMessage(chatId, `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${result.dieType || 'Không rõ'}`);
        }
    }
});

// ================= TEXT MESSAGES HANDLER =================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);

    if (session && session.state === 'AWAITING_UID') {
        const uid = extractUID(msg.text);
        if (!uid) return bot.sendMessage(chatId, '❌ Lỗi: Không tìm thấy UID hợp lệ!');

        const result = await smartCheck(uid);

        if (result.status === 'LIVE') {
            bot.sendMessage(chatId, `✅ UID của bạn là: \`${uid}\``);
            userSessions.delete(chatId);
        } 
        else if (result.status === 'DIE') {
            // Khớp 100% Giao diện check tay trong ảnh mẫu của bạn
            const textDie = `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${result.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
            bot.sendMessage(chatId, textDie, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Lưu UID', callback_data: `save_uid_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_uid` }],
                        [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]
                    ]
                }
            });
            userSessions.delete(chatId);
        } 
        else if (result.status === 'COOKIE_DIE') {
            bot.sendMessage(chatId, `⚠️ COOKIE FACEBOOK ĐÃ DIE`);
            userSessions.delete(chatId);
        }
    } 
    else if (session && session.state === 'AWAITING_ACC_NAME') {
        const uid = session.tempUid;
        const accName = msg.text;
        
        db.run(
            `INSERT OR REPLACE INTO accounts (uid, chat_id, name, created_at) VALUES (?, ?, ?, ?)`,
            [uid, chatId, accName, new Date().toISOString()],
            (err) => {
                if (!err) bot.sendMessage(chatId, `✅ Đã thêm UID thành công.`);
                userSessions.delete(chatId);
            }
        );
    }
});

// ================= AUTO MONITORING (CRON JOB) =================
cron.schedule('*/1 * * * *', async () => {
    db.all(`SELECT * FROM accounts WHERE is_tracking = 1`, async (err, rows) => {
        if (!rows || rows.length === 0) return;
        for (const row of rows) {
            await queue.add(async () => {
                const result = await smartCheck(row.uid);
                if (result.status === 'ERROR' || result.status === 'COOKIE_DIE') return; 

                // Khớp Giao diện cảnh báo tự động chạy ngầm trong ảnh mẫu của bạn
                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const failCount = row.fail_count + 1;
                    if (failCount >= 3) {
                        const msgText = `🍂 \`${row.uid}\` đã DIE ❌\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${formatTime()}`;
                        
                        bot.sendMessage(row.chat_id, msgText, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                                ]
                            }
                        });
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0 WHERE uid=?`, [result.dieType, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=? WHERE uid=?`, [failCount, row.uid]);
                    }
                } 
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const msgText = `🟢 *THÔNG BÁO: UID ĐÃ SỐNG LẠI*\n\n🆔 UID: \`${row.uid}\`\n👤 Tài Khoản: ${row.name}\n🌿 Trạng thái: LIVE\n⏰ Báo cáo lúc: ${formatTime()}`;
                    
                    bot.sendMessage(row.chat_id, msgText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                            ]
                        }
                    });
                    db.run(`UPDATE accounts SET status='LIVE', fail_count=0, die_type='Không rõ' WHERE uid=?`, [row.uid]);
                } 
                else if (result.status === 'LIVE') {
                    db.run(`UPDATE accounts SET fail_count=0 WHERE uid=?`, [row.uid]);
                }
            });
        }
    });
});

// ================= RENDER WEB SERVER =================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🟢 System Online'));
app.listen(PORT, () => console.log(`🚀 SYSTEM READY trên port ${PORT}`));
