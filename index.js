require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG (ĐÃ BỎ OPENAI) =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [], 
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 3,
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// ================= CÀI ĐẶT MENU TELEGRAM =================
bot.setMyCommands([
    { command: 'check', description: 'Kiểm tra trạng thái UID' },
    { command: 'listacc', description: 'Xem danh sách đang theo dõi' },
    { command: 'status', description: 'Xem thống kê tổng quan' },
    { command: 'menu', description: 'Hiển thị bảng hướng dẫn' }
]).then(() => console.log('✅ Đã nạp Menu UI cho Telegram')).catch(console.error);

const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

// ================= DATABASE =================
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            name TEXT,
            note TEXT,
            status TEXT DEFAULT 'LIVE',
            die_type TEXT DEFAULT '',
            fail_count INTEGER DEFAULT 0,
            live_count INTEGER DEFAULT 0,
            start_date TEXT,
            last_check TEXT,
            last_change TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);
    db.run(`ALTER TABLE accounts ADD COLUMN is_active INTEGER DEFAULT 1`, (err) => {});
});

// ================= HELPERS =================
const formatTime = () => {
    return new Date().toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
        hour: '2-digit', minute:'2-digit', second:'2-digit',
        day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(' ', ' '); 
};

const extractUID = (input) => {
    if (!input) return null;
    const clean = input.trim();
    const match = clean.match(/(\d{5,20})/);
    if (match) return match[1];
    return clean.replace(/https?:\/\/(www\.|m\.|mbasic\.)?facebook\.com\//, '').replace(/\//g, '');
};

const safeSend = async (chatId, text, opts = {}) => {
    try {
        return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
    } catch (e) {
        console.error(`[Telegram Error] Cannot send message:`, e.message);
    }
};

const isAdmin = (chatId) => {
    if (CONFIG.ADMIN_IDS.length === 0) return true;
    return CONFIG.ADMIN_IDS.includes(String(chatId));
};

// ================= UI GENERATOR (CHUẨN ẢNH 100%) =================
// Hàm này đảm bảo mọi thông báo về tài khoản đều chung 1 giao diện
const generateAccountUI = (row) => {
    const isLive = row.status === 'LIVE';
    const statusIcon = isLive ? '✅' : '❌';
    const activeText = row.is_active === 0 ? ' *(Đang Tạm Dừng)*' : '';
    
    // Giao diện y hệt ảnh lúc DIE / LIVE
    let text = ``;
    if (isLive) {
        text += `🌿 \`${row.uid}\` đang LIVE ${statusIcon}${activeText}\n`;
    } else {
        text += `🍂 \`${row.uid}\` đã DIE ${statusIcon}${activeText}\n`;
    }
    
    text += `👤 Tài Khoản: ${row.name}\n`;
    text += `📝 Ghi Chú: ${row.note}\n`;
    text += `⏰ Thời Gian: ${formatTime()}`;

    if (row.die_type && !isLive) {
        text += `\n⚠️ Die Dạng: ${row.die_type}`;
    }

    // Các nút bấm đồng nhất
    const buttons = [
        [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
        [{ text: '✏️ Đổi Tên', callback_data: `editname_${row.uid}` }, { text: '🏷 Đổi Ghi Chú', callback_data: `editnote_${row.uid}` }],
        [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
    ];

    return { text, reply_markup: { inline_keyboard: buttons } };
};

// ================= FACEBOOK CHECKER =================
async function smartCheck(uid) {
    try {
        const urls = [`https://mbasic.facebook.com/${uid}`, `https://m.facebook.com/${uid}`];
        let finalResult = { status: 'ERROR' };

        for (const url of urls) {
            try {
                const res = await axios.get(url, {
                    headers: {
                        'cookie': CONFIG.FB_COOKIE || '',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'accept-language': 'vi-VN,vi;q=0.9',
                        'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT, maxRedirects: 0, validateStatus: () => true
                });

                const html = String(res.data).toLowerCase();
                const location = res.headers.location || '';

                if (res.status === 200 && (html.includes('profile') || html.includes('facebook') || html.includes('timeline'))) {
                    finalResult = { status: 'LIVE' }; break;
                }

                if (location.includes('checkpoint') || location.includes('recover') || location.includes('help')) {
                    let type = 'Checkpoint';
                    if (location.includes('282')) type = '282';
                    if (location.includes('956')) type = '956';
                    finalResult = { status: 'DIE', dieType: type }; break;
                }

                const dieKeywords = ["nội dung này hiện không khả dụng", "không tìm thấy nội dung", "this content isn't available", "trang này hiện không khả dụng"];
                if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
                    finalResult = { status: 'DIE', dieType: '583' }; break;
                }
            } catch (e) {}
        }
        return finalResult;
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= LỆNH QUẢN LÝ TÀI KHOẢN =================
bot.onText(/\/start|\/help|\/menu/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const menu = `
📂 *FACEBOOK PRO MONITOR*
━━━━━━━━━━━━━━━
Dùng lệnh /check để kiểm tra và thêm UID mới.
Các nút bấm sẽ tự xuất hiện dưới mỗi tài khoản để bạn quản lý trực tiếp!

/check - Kiểm tra & Thêm UID
/listacc - Xem danh sách theo dõi
/status - Xem thống kê hệ thống
`;
    bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
});

bot.onText(/\/check$/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    bot.sendMessage(chatId, '📩 *Vui lòng nhập UID Hoặc URL:*', {
        parse_mode: 'Markdown', reply_markup: { force_reply: true }
    });
});

bot.onText(/\/check(?:\s+(.+))/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const uid = extractUID(match[1]);
    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');
    processCheck(chatId, uid);
});

async function processCheck(chatId, uid) {
    const checkMsg = await safeSend(chatId, `🔎 Đang kiểm tra realtime: \`${uid}\``);
    const res = await smartCheck(uid);
    
    let text = '', buttons = [];
    if (res.status === 'LIVE') {
        text = `✅ UID \`${uid}\` đang **LIVE**\n⏰ Thời gian: ${formatTime()}\n\n📌 Bạn có muốn lưu UID này không?`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }], [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    } else if (res.status === 'DIE') {
        text = `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${res.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }], [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    } else {
        text = `⚠️ UID \`${uid}\` Lỗi kết nối (Hoặc do IP/Cookie bị chặn).`;
        buttons = [[{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    }

    bot.deleteMessage(chatId, checkMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ================= HANDLER TIN NHẮN THÔNG MINH (REPLY) =================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !isAdmin(chatId) || text.startsWith('/')) return;

    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text;

        // Xử lý Check UID
        if (replyText.includes('Vui lòng nhập UID Hoặc URL:')) {
            const uid = extractUID(text);
            if (uid) return processCheck(chatId, uid);
            return safeSend(chatId, '❌ UID không hợp lệ.');
        }

        // Xử lý Lưu UID
        if (replyText.includes('[Lưu UID Mới]')) {
            const match = replyText.match(/UID:\s*(\d+)/);
            if (!match) return;
            const uid = match[1];
            const parts = text.split('|').map(v => v.trim());
            return addAccount(chatId, uid, parts[0] || 'Chưa đặt tên', parts[1] || '🦦');
        }

        // Xử lý Đổi Tên
        if (replyText.includes('[Đổi Tên]')) {
            const match = replyText.match(/UID:\s*(\d+)/);
            if (!match) return;
            const uid = match[1];
            db.run(`UPDATE accounts SET name = ? WHERE uid = ?`, [text, uid], () => {
                safeSend(chatId, `✅ Đã cập nhật Tên mới cho UID \`${uid}\``);
                sendAccountInfo(chatId, uid); // Render lại UI mới
            });
            return;
        }

        // Xử lý Đổi Ghi Chú
        if (replyText.includes('[Đổi Ghi Chú]')) {
            const match = replyText.match(/UID:\s*(\d+)/);
            if (!match) return;
            const uid = match[1];
            db.run(`UPDATE accounts SET note = ? WHERE uid = ?`, [text, uid], () => {
                safeSend(chatId, `✅ Đã cập nhật Ghi chú mới cho UID \`${uid}\``);
                sendAccountInfo(chatId, uid); // Render lại UI mới
            });
            return;
        }
    }
});

async function addAccount(chatId, uid, name, note) {
    const checkMsg = await safeSend(chatId, `🔎 Đang khởi tạo dữ liệu UID: \`${uid}\``);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, die_type, start_date, last_check, last_change, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [uid, chatId, name, note, check.status, check.dieType || '', now, now, now], 
    async (err) => {
        bot.deleteMessage(chatId, checkMsg.message_id).catch(() => {});
        if (err) return safeSend(chatId, '❌ Lỗi Database.');
        sendAccountInfo(chatId, uid); // Gửi UI chuẩn
    });
}

function sendAccountInfo(chatId, uid) {
    db.get(`SELECT * FROM accounts WHERE uid = ?`, [uid], (err, row) => {
        if (!row) return;
        const ui = generateAccountUI(row);
        bot.sendMessage(chatId, ui.text, { parse_mode: 'Markdown', reply_markup: ui.reply_markup });
    });
}

// ================= QUẢN LÝ NÚT BẤM (ĐÃ CHUẨN HÓA) =================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startsWith('save_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Lưu UID Mới]\nUID: ${uid}\n\nVui lòng nhập Tên và Ghi chú theo định dạng:\n\`Tên tài khoản | Ghi chú của bạn\``, { 
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true } 
        });
    } 
    else if (data.startsWith('ignore_')) {
        bot.answerCallbackQuery(query.id, { text: 'Đã bỏ qua!' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    } 
    else if (data.startsWith('recheck_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: 'Đang check lại...' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
        processCheck(chatId, uid);
    }
    else if (data.startsWith('continue_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=1 WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã tiếp tục theo dõi', show_alert: true });
        bot.deleteMessage(chatId, msgId).catch(() => {});
        sendAccountInfo(chatId, uid); // Cập nhật lại UI
    }
    else if (data.startsWith('pause_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=0 WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🛑 Đã tạm dừng theo dõi', show_alert: true });
        bot.deleteMessage(chatId, msgId).catch(() => {});
        sendAccountInfo(chatId, uid); // Cập nhật lại UI
    }
    else if (data.startsWith('editname_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Đổi Tên]\nUID: ${uid}\n\n👉 Nhập tên mới cho tài khoản này:`, { reply_markup: { force_reply: true } });
    }
    else if (data.startsWith('editnote_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Đổi Ghi Chú]\nUID: ${uid}\n\n👉 Nhập ghi chú mới cho tài khoản này:`, { reply_markup: { force_reply: true } });
    }
    else if (data.startsWith('delete_')) {
        const uid = data.split('_')[1];
        db.run(`DELETE FROM accounts WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🗑 Đã xóa UID', show_alert: true });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    }
});

// ================= LIST & STATUS =================
bot.onText(/\/listacc/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    db.all(`SELECT * FROM accounts ORDER BY last_check DESC`, [], async (err, rows) => {
        if (!rows || rows.length === 0) return safeSend(chatId, '📭 Chưa có UID nào trong hệ thống.');
        safeSend(chatId, '📋 *Bắt đầu xuất danh sách...*');
        // Gửi từng acc với form chuẩn để quản lý được luôn
        for (const row of rows) {
            sendAccountInfo(chatId, row.uid);
            await new Promise(resolve => setTimeout(resolve, 300)); // Delay tránh spam Telegram
        }
    });
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    db.all(`SELECT status, is_active, COUNT(*) as total FROM accounts GROUP BY status, is_active`, [], async (err, rows) => {
        let live = 0, die = 0, paused = 0;
        rows.forEach(r => {
            if (r.is_active === 0) paused += r.total;
            else if (r.status === 'LIVE') live += r.total;
            else if (r.status === 'DIE') die += r.total;
        });
        safeSend(chatId, `📊 *THỐNG KÊ HỆ THỐNG*\n✅ Đang theo dõi (LIVE): ${live}\n❌ Đã DIE: ${die}\n⏸ Đang tạm dừng: ${paused}\n⏰ ${formatTime()}`);
    });
});

// ================= AUTO MONITOR (CHUẨN FORM) =================
let isCronRunning = false;

cron.schedule('*/1 * * * *', () => {
    if (queue.size > 0 || isCronRunning) return;
    isCronRunning = true;

    db.all(`SELECT * FROM accounts WHERE is_active = 1`, async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            isCronRunning = false; return;
        }
        
        for (const row of rows) {
            queue.add(async () => {
                const now = formatTime();
                const result = await smartCheck(row.uid);

                if (result.status === 'ERROR') return;

                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= CONFIG.MAX_FAIL) {
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=?, last_change=? WHERE uid=?`, [result.dieType, now, now, row.uid], () => {
                            sendAccountInfo(row.chat_id, row.uid); // Bắn thông báo UI chuẩn khi DIE
                        });
                    } else {
                        db.run(`UPDATE accounts SET fail_count=?, last_check=? WHERE uid=?`, [fail, now, row.uid]);
                    }
                } 
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) {
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid], () => {
                            sendAccountInfo(row.chat_id, row.uid); // Bắn thông báo UI chuẩn khi LIVE lại
                        });
                    } else {
                        db.run(`UPDATE accounts SET live_count=?, last_check=? WHERE uid=?`, [liveCount, now, row.uid]);
                    }
                } 
                else {
                    db.run(`UPDATE accounts SET last_check=?, fail_count=0, live_count=0 WHERE uid=?`, [now, row.uid]);
                }
            });
        }
        queue.onIdle().then(() => { isCronRunning = false; });
    });
});

// ================= EXPRESS =================
const app = express();
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Active (No AI)</h2>`));
app.listen(process.env.PORT || 3000, () => console.log('✅ Server Running'));
