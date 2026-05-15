require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');
const { OpenAI } = require('openai');

// ================= CONFIG =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [], 
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 3,
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

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
});

// ================= HELPERS & UI GENERATOR =================
const formatTime = () => {
    return new Date().toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
        hour: '2-digit', minute:'2-digit', second:'2-digit',
        day: '2-digit', month: '2-digit', year: 'numeric'
    }).replace(' ', ' '); 
};

const extractUID = (input) => {
    if (!input) return null;
    const match = input.match(/(\d{5,20})/);
    return match ? match[1] : null;
};

const safeSend = async (chatId, text, opts = {}) => {
    try {
        return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
    } catch (e) {
        console.error(`[Telegram Error]:`, e.message);
    }
};

const isAdmin = (chatId) => {
    if (CONFIG.ADMIN_IDS.length === 0) return true;
    return CONFIG.ADMIN_IDS.includes(String(chatId));
};

const generateAccountUI = (row) => {
    const isLive = row.status === 'LIVE';
    const statusIcon = isLive ? '✅' : '❌';
    const activeText = row.is_active === 0 ? ' *(Đang Tạm Dừng)*' : '';
    
    let text = isLive 
        ? `🌿 \`${row.uid}\` đang LIVE ${statusIcon}${activeText}\n`
        : `🍂 \`${row.uid}\` đã DIE ${statusIcon}${activeText}\n`;
    
    text += `👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${formatTime()}`;
    if (row.die_type && !isLive) text += `\n⚠️ Die Dạng: ${row.die_type}`;

    const buttons = [
        [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
        [{ text: '✏️ Đổi Tên', callback_data: `editname_${row.uid}` }, { text: '🏷 Đổi Ghi Chú', callback_data: `editnote_${row.uid}` }],
        [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
    ];

    return { text, reply_markup: { inline_keyboard: buttons } };
};

function sendAccountInfo(chatId, uid) {
    db.get(`SELECT * FROM accounts WHERE uid = ?`, [uid], (err, row) => {
        if (!row) return;
        const ui = generateAccountUI(row);
        bot.sendMessage(chatId, ui.text, { parse_mode: 'Markdown', reply_markup: ui.reply_markup });
    });
}

// ================= SMART FACEBOOK CHECKER V2 =================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36'
];

function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function requestFacebook(url) {
    try {
        const res = await axios.get(url, {
            headers: {
                cookie: CONFIG.FB_COOKIE || '',
                'user-agent': randomUA(),
                'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                accept: 'text/html,application/xhtml+xml',
                pragma: 'no-cache',
                'cache-control': 'no-cache'
            },
            timeout: CONFIG.REQUEST_TIMEOUT,
            maxRedirects: 0,
            validateStatus: () => true
        });
        return res;
    } catch (e) {
        return null;
    }
}

async function smartCheck(uid) {
    const urls = [
        `https://mbasic.facebook.com/${uid}`,
        `https://m.facebook.com/${uid}`,
        `https://www.facebook.com/${uid}`,
        `https://www.facebook.com/profile.php?id=${uid}`
    ];

    let detected = { status: 'ERROR' };

    for (const url of urls) {
        const res = await requestFacebook(url);
        if (!res) continue;

        const html = String(res.data).toLowerCase();
        const location = String(res.headers.location || '').toLowerCase();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch?.[1]?.toLowerCase() || '';

        // ================= LIVE =================
        const liveSignals = ['timeline', 'profile', 'facebook', 'stories', 'friends', 'photos'];
        if (res.status === 200 && liveSignals.some(v => html.includes(v))) {
            return { status: 'LIVE' };
        }

        // ================= CHECKPOINT =================
        if (location.includes('checkpoint') || html.includes('checkpoint') || location.includes('recover') || html.includes('confirm identity')) {
            let type = 'Checkpoint';
            if (location.includes('282')) type = '282';
            if (location.includes('956')) type = '956';
            return { status: 'DIE', dieType: type };
        }

        // ================= LOCK =================
        if (html.includes('your account has been locked') || html.includes('account locked') || html.includes('tài khoản của bạn đã bị khóa')) {
            return { status: 'DIE', dieType: 'LOCK' };
        }

        // ================= MEMORIAL =================
        if (html.includes('remembering') || html.includes('tưởng nhớ')) {
            return { status: 'DIE', dieType: 'MEMORIAL' };
        }

        // ================= DISABLED =================
        if (html.includes('disabled') || html.includes('đã vô hiệu hóa')) {
            return { status: 'DIE', dieType: 'DISABLED' };
        }

        // ================= DIE 583 =================
        const dieKeywords = ["this content isn't available", "content isn't available", "page isn't available", "nội dung này hiện không khả dụng", "trang này hiện không khả dụng", "không tìm thấy nội dung", "the link may be broken", "liên kết bạn truy cập có thể bị hỏng"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404 || title.includes('error')) {
            return { status: 'DIE', dieType: '583' };
        }

        // ================= LOGIN WALL =================
        if (location.includes('login') || html.includes('login')) {
            detected = { status: 'LIVE' };
        }
    }
    return detected;
}

// ================= QUẢN LÝ THÊM & CHECK TÀI KHOẢN =================
async function addAccount(chatId, uid, name, note) {
    const check = await smartCheck(uid);
    const now = formatTime();
    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, die_type, start_date, last_check, last_change, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [uid, chatId, name, note, check.status, check.dieType || '', now, now, now], 
    (err) => {
        if (!err) sendAccountInfo(chatId, uid); 
    });
}

bot.onText(/\/check$/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    bot.sendMessage(chatId, '📩 *Vui lòng nhập UID Hoặc URL:*', {
        parse_mode: 'Markdown', reply_markup: { force_reply: true }
    });
});

async function processManualCheck(chatId, uid) {
    const checkMsg = await safeSend(chatId, `🔎 Đang kiểm tra realtime V2: \`${uid}\``);
    const res = await smartCheck(uid);
    
    let text = '', buttons = [];
    if (res.status === 'LIVE') {
        text = `✅ UID \`${uid}\` đang **LIVE**\n⏰ Thời gian: ${formatTime()}\n\n📌 Bạn có muốn lưu UID này không?`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }]];
    } else if (res.status === 'DIE') {
        text = `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${res.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }]];
    } else {
        text = `⚠️ UID \`${uid}\` Lỗi kết nối. (Có thể do Cookie hỏng hoặc FB block IP)`;
    }

    bot.deleteMessage(chatId, checkMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ================= TIN NHẮN TỰ NHIÊN & AI HANDLER =================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !isAdmin(chatId) || text.startsWith('/')) return;

    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text;
        
        if (replyText.includes('Vui lòng nhập UID Hoặc URL:')) {
            const uid = extractUID(text);
            if (uid) return processManualCheck(chatId, uid);
            return safeSend(chatId, '❌ UID không hợp lệ.');
        }

        const match = replyText.match(/UID:\s*(\d+)/);
        if (match) {
            const uid = match[1];
            if (replyText.includes('[Lưu UID]')) {
                const parts = text.split('|').map(v => v.trim());
                return addAccount(chatId, uid, parts[0] || 'Chưa đặt tên', parts[1] || '🦦');
            }
            if (replyText.includes('[Đổi Tên]')) {
                db.run(`UPDATE accounts SET name = ? WHERE uid = ?`, [text, uid], () => sendAccountInfo(chatId, uid));
                return;
            }
            if (replyText.includes('[Đổi Ghi Chú]')) {
                db.run(`UPDATE accounts SET note = ? WHERE uid = ?`, [text, uid], () => sendAccountInfo(chatId, uid));
                return;
            }
        }
        return;
    }

    // AI THÔNG MINH XỬ LÝ NLP
    const waitMsg = await safeSend(chatId, '🧠 _AI đang dịch và phân tích yêu cầu..._');

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: `Bạn là trợ lý AI quản lý Facebook. Nhiệm vụ của bạn:
1. Hiểu đa ngôn ngữ. Dịch yêu cầu sang tiếng Việt.
2. Trích xuất UID, Tên (mặc định "Chưa đặt tên"), Ghi chú (mặc định "🦦").
3. Phản hồi JSON:
{
  "action": "add_account" hoặc "reply",
  "data": [{ "uid": "123", "name": "Tên", "note": "Ghi chú" }],
  "ai_message": "Câu phản hồi thân thiện bằng tiếng Việt"
}`
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });

        const aiResult = JSON.parse(response.choices[0].message.content);
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

        if (aiResult.action === 'add_account' && aiResult.data.length > 0) {
            safeSend(chatId, `🤖 ${aiResult.ai_message}\nĐang xử lý ${aiResult.data.length} UID...`);
            for (const acc of aiResult.data) {
                const uid = extractUID(acc.uid);
                if (uid) await addAccount(chatId, uid, acc.name, acc.note);
            }
        } else {
            safeSend(chatId, `🤖 AI: ${aiResult.ai_message}`);
        }
    } catch (error) {
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
        console.error("AI Error:", error.message);
    }
});

// ================= QUẢN LÝ BUTTONS =================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startsWith('save_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Lưu UID]\nUID: ${uid}\n👉 Nhập theo định dạng: \`Tên | Ghi chú\``, { reply_markup: { force_reply: true }, parse_mode: 'Markdown' });
    }
    else if (data.startsWith('ignore_')) {
        bot.answerCallbackQuery(query.id, { text: 'Đã bỏ qua!' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    }
    else if (data.startsWith('continue_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=1 WHERE uid=?`, [uid], () => {
            bot.answerCallbackQuery(query.id, { text: '✅ Đã tiếp tục theo dõi' });
            bot.deleteMessage(chatId, msgId).catch(() => {});
            sendAccountInfo(chatId, uid);
        });
    }
    else if (data.startsWith('pause_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=0 WHERE uid=?`, [uid], () => {
            bot.answerCallbackQuery(query.id, { text: '🛑 Đã tạm dừng theo dõi' });
            bot.deleteMessage(chatId, msgId).catch(() => {});
            sendAccountInfo(chatId, uid);
        });
    }
    else if (data.startsWith('editname_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Đổi Tên]\nUID: ${uid}\n👉 Nhập tên mới:`, { reply_markup: { force_reply: true } });
    }
    else if (data.startsWith('editnote_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `[Đổi Ghi Chú]\nUID: ${uid}\n👉 Nhập ghi chú mới:`, { reply_markup: { force_reply: true } });
    }
    else if (data.startsWith('delete_')) {
        const uid = data.split('_')[1];
        db.run(`DELETE FROM accounts WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🗑 Đã xóa UID' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    }
});

// ================= LIST & STATUS =================
bot.onText(/\/listacc/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    db.all(`SELECT * FROM accounts ORDER BY last_check DESC`, [], async (err, rows) => {
        if (!rows || rows.length === 0) return safeSend(chatId, '📭 Chưa có UID nào.');
        for (const row of rows) {
            sendAccountInfo(chatId, row.uid);
            await new Promise(resolve => setTimeout(resolve, 300));
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
        safeSend(chatId, `📊 *THỐNG KÊ*\n✅ LIVE: ${live}\n❌ DIE: ${die}\n⏸ Tạm dừng: ${paused}\n⏰ ${formatTime()}`);
    });
});

// ================= AUTO MONITOR =================
let isCronRunning = false;
cron.schedule('*/1 * * * *', () => {
    if (queue.size > 0 || isCronRunning) return;
    isCronRunning = true;
    db.all(`SELECT * FROM accounts WHERE is_active = 1`, async (err, rows) => {
        if (err || !rows || rows.length === 0) { isCronRunning = false; return; }
        for (const row of rows) {
            queue.add(async () => {
                const now = formatTime();
                const result = await smartCheck(row.uid);
                if (result.status === 'ERROR') return;

                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= CONFIG.MAX_FAIL) {
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=?, last_change=? WHERE uid=?`, [result.dieType, now, now, row.uid], () => sendAccountInfo(row.chat_id, row.uid));
                    } else {
                        db.run(`UPDATE accounts SET fail_count=?, last_check=? WHERE uid=?`, [fail, now, row.uid]);
                    }
                } 
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) {
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid], () => sendAccountInfo(row.chat_id, row.uid));
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

const app = express();
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Active (V2)</h2>`));
app.listen(process.env.PORT || 3000, () => console.log('✅ Server Running'));
