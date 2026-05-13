require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG & INIT =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    CHECK_INTERVAL: 15000,
    RETRY_COUNT: 3
};

if (!CONFIG.BOT_TOKEN) {
    console.error('❌ THIẾU TELEGRAM_BOT_TOKEN trong .env');
    process.exit(1);
}

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./uid_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });
const sessions = {}; 

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

// ================= DATABASE SETUP =================
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            name TEXT DEFAULT 'chưa cập nhật',
            note TEXT DEFAULT '🦦',
            status TEXT DEFAULT 'LIVE',
            die_type TEXT DEFAULT '',
            is_tracking INTEGER DEFAULT 1,
            fail_count INTEGER DEFAULT 0,
            created_at TEXT,
            last_check TEXT,
            die_time TEXT,
            live_back_time TEXT
        )
    `);
});

// ================= HELPER FUNCTIONS =================
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const formatTime = () => {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')} ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
};
const extractUID = (input) => {
    const match = input.trim().match(/(\d{5,20})/);
    return match ? match[1] : null;
};

const detectDieType = (url, html) => {
    if (!url) return null;
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
    return 'Không xác định';
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

        if (location.includes('login.php') && !html.includes('profile')) return { status: 'COOKIE_DIE' };
        if (location.includes('checkpoint') || location.includes('help') || location.includes('recover')) {
            const dieType = detectDieType(location, html);
            return { status: 'DIE', dieType: dieType || 'Checkpoint' };
        }
        const dieKeywords = ["this content isn't available", "nội dung này hiện không khả dụng", "không tìm thấy nội dung"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) return { status: 'DIE', dieType: 'Not Found / 404' };

        return { status: 'LIVE' };
    } catch (e) {
        return { status: 'ERROR', error: e.message };
    }
}

// ================= BOT COMMANDS =================
bot.setMyCommands([
    { command: '/start', description: 'Mở Menu hệ thống' },
    { command: '/check', description: 'Check Live/Die UID' },
    { command: '/list', description: 'Xem danh sách UID đang theo dõi' }
]);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `🚀 *HỆ THỐNG MONITOR UID PRO*\n\nGõ /check để bắt đầu kiểm tra.\nGõ /list để xem danh sách UID.`, {parse_mode: 'Markdown'});
});

bot.onText(/\/list/, (msg) => {
    db.all(`SELECT * FROM accounts`, (err, rows) => {
        if (!rows || rows.length === 0) return bot.sendMessage(msg.chat.id, '📭 Danh sách trống.');
        let text = '📋 *DANH SÁCH UID ĐANG THEO DÕI*\n\n';
        rows.forEach(r => {
            const status = r.status === 'LIVE' ? '🟢 LIVE' : '🔴 DIE';
            const tracking = r.is_tracking ? '' : '(Đang dừng)';
            text += `• \`${r.uid}\` | ${r.name} | ${status} ${tracking}\n`;
        });
        bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });
});

bot.onText(/\/check/, (msg) => {
    const chatId = msg.chat.id;
    sessions[chatId] = { state: 'AWAITING_UID' };
    bot.sendMessage(chatId, '📬 Vui lòng nhập UID Hoặc URL:', { reply_markup: { force_reply: true } });
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const session = sessions[chatId];

    if (session && session.state === 'AWAITING_UID') {
        const uid = extractUID(msg.text);
        if (!uid) return bot.sendMessage(chatId, '❌ Lỗi: Không tìm thấy UID hợp lệ!');

        const result = await smartCheck(uid);

        if (result.status === 'LIVE') {
            bot.sendMessage(chatId, `✅ UID của bạn là: ${uid} (Đang LIVE)\n📌 Nhập Tên/Ghi chú để lưu vào danh sách:`);
            sessions[chatId] = { state: 'AWAITING_ACC_NAME', tempUid: uid };
        } else if (result.status === 'DIE') {
            sessions[chatId] = { state: 'AWAITING_SAVE_DECISION', tempUid: uid };
            bot.sendMessage(chatId, `❌ UID ${uid} đã DIE.\n⚠️ Die Dạng: ${result.dieType || 'Không rõ'}\n\n📌 Bạn có muốn lưu UID này không?`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Lưu UID', callback_data: `save_uid_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_uid` }],
                        [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]
                    ]
                }
            });
        } else {
            bot.sendMessage(chatId, `⚠️ Hệ thống kiểm tra đang lỗi hoặc Cookie bị die.`);
            delete sessions[chatId];
        }
    } 
    else if (session && session.state === 'AWAITING_ACC_NAME') {
        const uid = session.tempUid;
        const accName = msg.text;
        
        db.run(
            `INSERT OR REPLACE INTO accounts (uid, chat_id, name, created_at, last_check) VALUES (?, ?, ?, ?, ?)`,
            [uid, chatId, accName, new Date().toISOString(), new Date().toISOString()],
            (err) => {
                if (!err) bot.sendMessage(chatId, `✅ Đã lưu UID: ${uid} vào hệ thống.`);
                delete sessions[chatId];
            }
        );
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('save_uid_')) {
        const uid = data.replace('save_uid_', '');
        sessions[chatId] = { state: 'AWAITING_ACC_NAME', tempUid: uid };
        bot.sendMessage(chatId, '📝 Vui lòng nhập Tên Tài Khoản/Ghi chú:', { reply_markup: { force_reply: true } });
        bot.answerCallbackQuery(query.id);
    } 
    else if (data === 'ignore_uid') {
        delete sessions[chatId];
        bot.deleteMessage(chatId, messageId);
        bot.answerCallbackQuery(query.id, { text: 'Đã bỏ qua.' });
    }
    else if (data.startsWith('pause_')) {
        const uid = data.replace('pause_', '');
        db.run(`UPDATE accounts SET is_tracking = 0 WHERE uid = ?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🛑 Đã dừng theo dõi' });
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
        bot.answerCallbackQuery(query.id, { text: '⏳ Đang check lại...' });
        const result = await smartCheck(uid);
        bot.sendMessage(chatId, `Trạng thái hiện tại: ${result.status}`);
    }
});

// ================= CRON JOB (AUTO MONITORING) =================
cron.schedule('*/1 * * * *', async () => {
    db.all(`SELECT * FROM accounts WHERE is_tracking = 1`, async (err, rows) => {
        if (!rows || rows.length === 0) return;
        for (const row of rows) {
            await queue.add(async () => {
                const result = await smartCheck(row.uid);
                if (result.status === 'ERROR' || result.status === 'COOKIE_DIE') return; 

                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const failCount = row.fail_count + 1;
                    if (failCount >= 3) {
                        const msgText = `🍂 ${row.uid} đã DIE ❌\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${formatTime()}`;
                        bot.sendMessage(row.chat_id, msgText, {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                                ]
                            }
                        });
                        db.run(`UPDATE accounts SET status='DIE', fail_count=0, die_type=?, die_time=?, last_check=? WHERE uid=?`, 
                            [result.dieType, new Date().toISOString(), new Date().toISOString(), row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=? WHERE uid=?`, [failCount, row.uid]);
                    }
                } 
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const msgText = `✅ THÔNG BÁO: UID ĐÃ SỐNG LẠI!\n\n🆔 UID: ${row.uid}\n🟢 Trạng thái: LIVE\n⏰ Báo cáo lúc: ${formatTime()}`;
                    bot.sendMessage(row.chat_id, msgText, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Tiếp tục theo dõi', callback_data: `resume_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                            ]
                        }
                    });
                    db.run(`UPDATE accounts SET status='LIVE', fail_count=0, die_type='', live_back_time=?, last_check=? WHERE uid=?`, 
                        [new Date().toISOString(), new Date().toISOString(), row.uid]);
                } 
                else if (result.status === 'LIVE') {
                    db.run(`UPDATE accounts SET fail_count=0, last_check=? WHERE uid=?`, [new Date().toISOString(), row.uid]);
                }
            });
        }
    });
});

// ================= RENDER WEB SERVER =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🟢 Bot Telegram Monitor UID đang hoạt động mượt mà!');
});

app.listen(PORT, () => {
    console.log(`🌍 Web Server đang chạy trên port ${PORT}`);
    console.log('🚀 SYSTEM READY');
});
