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
    OPENAI_API_KEY: process.env.OPENAI_API_KEY, // Thêm cấu hình OpenAI
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 3,
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY }); // Khởi tạo OpenAI

// ================= CÀI ĐẶT MENU TELEGRAM =================
bot.setMyCommands([
    { command: 'addacc', description: 'Thêm và theo dõi UID mới' },
    { command: 'check', description: 'Kiểm tra trạng thái UID' },
    { command: 'listacc', description: 'Xem danh sách đang theo dõi' },
    { command: 'delacc', description: 'Xóa UID khỏi hệ thống' },
    { command: 'setname', description: 'Đổi tên cho UID' },
    { command: 'setnote', description: 'Cập nhật ghi chú cho UID' },
    { command: 'info', description: 'Xem chi tiết một UID' },
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
    
    db.run(`ALTER TABLE accounts ADD COLUMN is_active INTEGER DEFAULT 1`, (err) => {
        if (!err) console.log('✅ Đã cập nhật Database thêm tính năng Tạm Dừng.');
    });
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
        console.error(`[Telegram Error] Cannot send message to ${chatId}:`, e.message);
    }
};

const statusIcon = (status) => status === 'LIVE' ? '✅' : '❌';

const isAdmin = (chatId) => {
    if (CONFIG.ADMIN_IDS.length === 0) return true;
    return CONFIG.ADMIN_IDS.includes(String(chatId));
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
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
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

                const dieKeywords = ["nội dung này hiện không khả dụng", "không tìm thấy nội dung", "this content isn't available", "content isn't available", "page isn't available", "trang này hiện không khả dụng"];
                if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
                    finalResult = { status: 'DIE', dieType: '583' }; break;
                }

            } catch (e) {
                console.error(`[Axios Error for ${uid}]:`, e.message);
            }
        }
        return finalResult;
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= MENU & LỆNH CŨ (Giữ nguyên) =================
const sendHelpMenu = (chatId) => {
    if (!isAdmin(chatId)) return safeSend(chatId, '⛔ *Truy cập bị từ chối.* Bạn không có quyền sử dụng bot này!');
    const menu = `
📂 *FACEBOOK PRO MONITOR*
━━━━━━━━━━━━━━━
🔵 *LỆNH TAY HOẶC CHAT VỚI AI*
Bạn có thể chat tự nhiên. Ví dụ:
_"Lưu cho mình 2 uid này nhé 10001, 10002. Tên là clone, note mua ngày hôm nay"_
━━━━━━━━━━━━━━━
🔵 *QUẢN LÝ FACEBOOK (Thủ công)*
/addacc UID | Tên | Note
/check UID
/listacc
/delacc UID
/status
`;
    bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
};

bot.onText(/\/start|\/help|\/menu/, (msg) => sendHelpMenu(msg.chat.id));

bot.onText(/\/addacc(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    if (!match[1]) return safeSend(chatId, '📝 *Vui lòng nhập thêm thông số*\n`/addacc UID | Tên | Note`');
    const parts = match[1].split('|').map(v => v.trim());
    const uid = extractUID(parts[0]);
    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');
    addAccount(chatId, uid, parts[1] || 'Chưa đặt tên', parts[2] || '🦦');
});

async function addAccount(chatId, uid, name, note) {
    safeSend(chatId, `🔎 Đang check realtime UID: \`${uid}\``);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, start_date, last_check, last_change, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [uid, chatId, name, note, check.status, now, now, now], 
    async (err) => {
        if (err) return safeSend(chatId, '❌ Lỗi Database.');
        await safeSend(chatId, `✅ *ĐÃ THÊM THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: *${name}*\n📝 Note: ${note}\n🌿 Trạng thái: ${check.status === 'LIVE' ? '✅ LIVE' : '❌ DIE'}`);
    });
}

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
    const checkMsg = await bot.sendMessage(chatId, `🔎 Đang kiểm tra realtime: \`${uid}\``, { parse_mode: 'Markdown' });
    const res = await smartCheck(uid);
    
    let text = '', buttons = [];
    if (res.status === 'LIVE') {
        text = `✅ UID \`${uid}\` đang **LIVE**\n⏰ Thời gian: ${formatTime()}`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }], [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    } else if (res.status === 'DIE') {
        text = `❌ UID \`${uid}\` đã DIE.\n⚠️ Die Dạng: ${res.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
        buttons = [[{ text: '✅ Lưu UID', callback_data: `save_${uid}` }, { text: '❌ Bỏ qua', callback_data: `ignore_${uid}` }], [{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    } else {
        text = `⚠️ UID \`${uid}\` Lỗi kết nối.`;
        buttons = [[{ text: '🔄 Check lại', callback_data: `recheck_${uid}` }]];
    }

    bot.deleteMessage(chatId, checkMsg.message_id).catch(() => {});
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
}

// ================= AI NLP MESSAGE HANDLER =================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !isAdmin(chatId)) return;
    
    // Nếu là reply cho lệnh /check
    if (msg.reply_to_message && msg.reply_to_message.text.includes('Vui lòng nhập UID Hoặc URL:')) {
        const uid = extractUID(text);
        if (uid) return processCheck(chatId, uid);
        return safeSend(chatId, '❌ UID không hợp lệ.');
    }

    // Nếu tin nhắn bắt đầu bằng "/", bỏ qua để các lệnh thủ công xử lý
    if (text.startsWith('/')) return;

    // Kích hoạt AI nhận diện ngữ nghĩa
    const waitMsg = await safeSend(chatId, '🧠 _AI đang phân tích yêu cầu..._');

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", // Hoặc gpt-4o-mini để nhanh và rẻ
            messages: [
                {
                    role: "system",
                    content: `Bạn là trợ lý ảo hỗ trợ quản lý tài khoản Facebook.
Nhiệm vụ: Trích xuất thông tin người dùng yêu cầu thành định dạng JSON.
Các action hợp lệ: "add_account", "check_status", "ignore".
Nếu người dùng muốn thêm UID để theo dõi (Lưu acc, thêm acc, theo dõi), dùng action "add_account".
Luôn tìm tất cả UID (dãy số dài) có trong câu. Nếu không có tên, gán name: "Chưa đặt tên". Nếu không có ghi chú, gán note: "🦦".
Định dạng JSON bắt buộc:
{
  "action": "add_account",
  "data": [
    { "uid": "10001...", "name": "Tên", "note": "Ghi chú" }
  ]
}
Chỉ trả về JSON hợp lệ, không giải thích gì thêm.`
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });

        const aiResult = JSON.parse(response.choices[0].message.content);
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

        if (aiResult.action === 'add_account' && aiResult.data && aiResult.data.length > 0) {
            safeSend(chatId, `🤖 AI đã nhận diện được **${aiResult.data.length}** UID. Đang tiến hành thêm vào hệ thống...`);
            for (const acc of aiResult.data) {
                const uid = extractUID(acc.uid);
                if (uid) {
                    await addAccount(chatId, uid, acc.name, acc.note);
                }
            }
        } else if (aiResult.action === 'check_status') {
            safeSend(chatId, `🤖 Bạn gõ lệnh /status để xem tổng quan nhé!`);
        } else {
            // Không phản hồi nếu chat vu vơ không chứa yêu cầu liên quan đến tool
        }
    } catch (error) {
        console.error("OpenAI Error:", error);
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    }
});

// ================= QUẢN LÝ BUTTONS (CALLBACK QUERY) =================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startsWith('save_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: 'AI đã sẵn sàng!' });
        bot.sendMessage(chatId, `🤖 UID \`${uid}\` đã chọn.\nBạn cứ chat tự nhiên để lưu. \nVí dụ: _"Lưu cho mình acc ${uid} này, note là acc chạy ads"_`, { parse_mode: 'Markdown' });
    } 
    else if (data.startsWith('ignore_')) {
        bot.answerCallbackQuery(query.id, { text: 'Đã bỏ qua!' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    } 
    else if (data.startsWith('recheck_')) {
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: 'Đang tiến hành check lại...' });
        bot.deleteMessage(chatId, msgId).catch(() => {});
        processCheck(chatId, uid);
    }
    else if (data.startsWith('continue_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=1 WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã tiếp tục theo dõi', show_alert: true });
    }
    else if (data.startsWith('pause_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE accounts SET is_active=0 WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🛑 Đã dừng theo dõi UID này', show_alert: true });
    }
    else if (data.startsWith('delete_')) {
        const uid = data.split('_')[1];
        db.run(`DELETE FROM accounts WHERE uid=?`, [uid]);
        bot.answerCallbackQuery(query.id, { text: '🗑 Đã xóa UID khỏi hệ thống', show_alert: true });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    }
});

// ================= LIST & SETNAME & SETNOTE & INFO & STATUS =================
bot.onText(/\/listacc/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    db.all(`SELECT * FROM accounts ORDER BY last_check DESC`, [], async (err, rows) => {
        if (!rows || rows.length === 0) return safeSend(chatId, '📭 Chưa có UID nào.');
        let text = `📋 *DANH SÁCH THEO DÕI*\n\n`;
        rows.forEach((r, i) => {
            const activeIcon = r.is_active === 1 ? '▶️' : '⏸';
            text += `${i + 1}. ${statusIcon(r.status)} \`${r.uid}\` ${activeIcon}\n👤 ${r.name}\n📝 ${r.note}\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        safeSend(chatId, text);
    });
});

bot.onText(/\/delacc(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    if (!match[1]) return safeSend(chatId, '📝 *Vui lòng nhập UID cần xóa*\nCú pháp: `/delacc UID`');
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], function(err) {
        if (this.changes > 0) safeSend(chatId, `🗑 Đã xóa UID: \`${uid}\``);
        else safeSend(chatId, '❌ UID không tồn tại.');
    });
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    db.all(`SELECT status, COUNT(*) as total FROM accounts GROUP BY status`, [], async (err, rows) => {
        let live = 0, die = 0;
        rows.forEach(r => {
            if (r.status === 'LIVE') live = r.total;
            if (r.status === 'DIE') die = r.total;
        });
        safeSend(chatId, `📊 *THỐNG KÊ HỆ THỐNG*\n✅ LIVE: ${live}\n❌ DIE: ${die}\n⏰ ${formatTime()}`);
    });
});

// ================= AUTO MONITOR =================
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
                        const alertText = `🍂 \`${row.uid}\` đã DIE ❌\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${now}`;
                        const opts = {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                                ]
                            }
                        };
                        await bot.sendMessage(row.chat_id, alertText, opts);
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=?, last_change=? WHERE uid=?`, [result.dieType, now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=?, last_check=? WHERE uid=?`, [fail, now, row.uid]);
                    }
                } 
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) {
                        await safeSend(row.chat_id, `🌿 *FACEBOOK ĐÃ LIVE LẠI*\n🆔 UID: \`${row.uid}\`\n👤 ${row.name}\n⏰ ${now}`);
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid]);
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
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Active</h2>`));
app.get('/status', (req, res) => {
    db.all(`SELECT * FROM accounts`, [], (err, rows) => res.json({ total: rows.length, data: rows }));
});
app.listen(process.env.PORT || 3000, () => console.log('✅ Server Running'));
