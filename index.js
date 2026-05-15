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

// Hàm xuất UI chuẩn 100% cho mọi phản hồi
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

// ================= FACEBOOK CHECKER =================
async function smartCheck(uid) {
    try {
        const urls = [`https://mbasic.facebook.com/${uid}`, `https://m.facebook.com/${uid}`];
        for (const url of urls) {
            try {
                const res = await axios.get(url, {
                    headers: { 'cookie': CONFIG.FB_COOKIE || '', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    timeout: CONFIG.REQUEST_TIMEOUT, maxRedirects: 0, validateStatus: () => true
                });
                const html = String(res.data).toLowerCase();
                const location = res.headers.location || '';

                if (res.status === 200 && (html.includes('profile') || html.includes('facebook') || html.includes('timeline'))) return { status: 'LIVE' };
                if (location.includes('checkpoint') || location.includes('recover')) return { status: 'DIE', dieType: location.includes('282') ? '282' : 'Checkpoint' };
                if (html.includes("không khả dụng") || res.status === 404) return { status: 'DIE', dieType: '583' };
            } catch (e) {}
        }
        return { status: 'ERROR' };
    } catch (e) { return { status: 'ERROR' }; }
}

async function addAccount(chatId, uid, name, note) {
    const check = await smartCheck(uid);
    const now = formatTime();
    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, die_type, start_date, last_check, last_change, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [uid, chatId, name, note, check.status, check.dieType || '', now, now, now], 
    (err) => {
        if (!err) sendAccountInfo(chatId, uid); // Render UI chuẩn ngay sau khi add
    });
}

// ================= TIN NHẮN TỰ NHIÊN & AI HANDLER =================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !isAdmin(chatId) || text.startsWith('/')) return;

    // Xử lý Force Reply (Nếu user đang bấm nút đổi tên/ghi chú thì không gọi AI)
    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text;
        const match = replyText.match(/UID:\s*(\d+)/);
        if (match) {
            const uid = match[1];
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

    // AI THÔNG MINH XỬ LÝ NLP & PHIÊN DỊCH
    const waitMsg = await safeSend(chatId, '🧠 _AI đang dịch và phân tích yêu cầu..._');

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", // Hoặc gpt-4o-mini
            messages: [
                {
                    role: "system",
                    content: `Bạn là trợ lý AI quản lý Facebook. Nhiệm vụ của bạn:
1. Hiểu đa ngôn ngữ (Tiếng Anh, Việt, Pháp...). Nếu người dùng dùng tiếng nước ngoài, hãy dịch nội dung yêu cầu ra tiếng Việt trong đầu bạn.
2. Trích xuất thông tin UID (dãy số), Tên (nếu có), Ghi chú (nếu có) để lưu vào hệ thống.
3. Nếu không có tên, mặc định là "Chưa đặt tên". Không có ghi chú, mặc định là "🦦".
4. Phản hồi bằng JSON:
{
  "action": "add_account" (nếu có uid để lưu) hoặc "reply" (nếu chỉ hỏi đáp bình thường),
  "data": [{ "uid": "123", "name": "Tên", "note": "Ghi chú" }],
  "ai_message": "Câu phản hồi thân thiện bằng tiếng Việt (Dịch nếu cần)"
}`
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });

        const aiResult = JSON.parse(response.choices[0].message.content);
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

        // Nếu AI phát hiện có lệnh lưu tài khoản
        if (aiResult.action === 'add_account' && aiResult.data.length > 0) {
            safeSend(chatId, `🤖 ${aiResult.ai_message}\nĐang xử lý ${aiResult.data.length} UID...`);
            for (const acc of aiResult.data) {
                const uid = extractUID(acc.uid);
                if (uid) await addAccount(chatId, uid, acc.name, acc.note);
            }
        } else {
            // Nếu chỉ là chat/hỏi đáp bình thường hoặc nhờ dịch
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

    if (data.startsWith('continue_')) {
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

// ================= CÁC LỆNH KHÁC & AUTO CRON (GIỮ NGUYÊN) =================
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
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Active</h2>`));
app.listen(process.env.PORT || 3000, () => console.log('✅ Server Running'));
