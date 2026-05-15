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

// ================= LỆNH QUẢN LÝ TÀI KHOẢN (FIX LỖI) =================
const sendHelpMenu = (chatId) => {
    if (!isAdmin(chatId)) return safeSend(chatId, '⛔ *Truy cập bị từ chối.* Bạn không có quyền sử dụng bot này!');
    const menu = `
📂 *FACEBOOK PRO MONITOR*
━━━━━━━━━━━━━━━
🔵 *LỆNH QUẢN LÝ*
/addacc UID | Tên | Note
/check UID
/listacc
/delacc UID
/setname UID Tên Mới
/setnote UID Note Mới
/info UID
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

// THÊM CHỨC NĂNG CÒN THIẾU Ở MENU
bot.onText(/\/setname(?:\s+(\d+)\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    if (!match[1] || !match[2]) return safeSend(chatId, '📝 *Cú pháp:* `/setname UID Tên_Mới`');
    db.run(`UPDATE accounts SET name = ? WHERE uid = ?`, [match[2], match[1]], function(err) {
        if (this.changes > 0) safeSend(chatId, `✅ Đã đổi tên UID \`${match[1]}\` thành: *${match[2]}*`);
        else safeSend(chatId, '❌ UID không tồn tại.');
    });
});

bot.onText(/\/setnote(?:\s+(\d+)\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    if (!match[1] || !match[2]) return safeSend(chatId, '📝 *Cú pháp:* `/setnote UID Note_Mới`');
    db.run(`UPDATE accounts SET note = ? WHERE uid = ?`, [match[2], match[1]], function(err) {
        if (this.changes > 0) safeSend(chatId, `✅ Đã đổi Ghi chú UID \`${match[1]}\` thành: *${match[2]}*`);
        else safeSend(chatId, '❌ UID không tồn tại.');
    });
});

bot.onText(/\/info(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    if (!match[1]) return safeSend(chatId, '📝 *Cú pháp:* `/info UID`');
    
    db.get(`SELECT * FROM accounts WHERE uid = ?`, [match[1]], (err, row) => {
        if (!row) return safeSend(chatId, '❌ UID không tồn tại trong hệ thống.');
        const statusText = row.status === 'LIVE' ? 'đang LIVE ✅' : 'đã DIE ❌';
        const typeText = row.die_type ? `\n⚠️ Die Dạng: ${row.die_type}` : '';
        const text = `ℹ️ *THÔNG TIN CHI TIẾT*\n🍂 \`${row.uid}\` ${statusText}${typeText}\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Cập nhật cuối: ${row.last_check}`;
        
        const opts = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                ]
            }
        };
        safeSend(chatId, text, opts);
    });
});

// FIX GIAO DIỆN ADDACC CHUẨN MÔ TẢ ẢNH
async function addAccount(chatId, uid, name, note) {
    const checkMsg = await safeSend(chatId, `🔎 Đang check realtime UID: \`${uid}\``);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, start_date, last_check, last_change, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [uid, chatId, name, note, check.status, now, now, now], 
    async (err) => {
        bot.deleteMessage(chatId, checkMsg.message_id).catch(() => {});
        if (err) return safeSend(chatId, '❌ Lỗi Database.');
        
        const statusText = check.status === 'LIVE' ? 'đang LIVE ✅' : 'đã DIE ❌';
        const typeText = check.dieType ? `\n⚠️ Die Dạng: ${check.dieType}` : '';
        
        const text = `✅ *ĐÃ THÊM VÀO HỆ THỐNG*\n🍂 \`${uid}\` ${statusText}${typeText}\n👤 Tài Khoản: ${name}\n📝 Ghi Chú: ${note}\n⏰ Thời Gian: ${now}`;
        
        const opts = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${uid}` }],
                    [{ text: '❌ Xóa UID', callback_data: `delete_${uid}` }]
                ]
            }
        };
        await safeSend(chatId, text, opts);
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

// ================= TIN NHẮN & AI HANDLER =================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !isAdmin(chatId)) return;
    if (text.startsWith('/')) return;

    // FIX LUỒNG CHAT: Xử lý Force Reply (Không dùng AI khi reply nút)
    if (msg.reply_to_message) {
        if (msg.reply_to_message.text.includes('Vui lòng nhập UID Hoặc URL:')) {
            const uid = extractUID(text);
            if (uid) return processCheck(chatId, uid);
            return safeSend(chatId, '❌ UID không hợp lệ.');
        }
        if (msg.reply_to_message.text.includes('Lưu UID:')) {
            const uid = msg.reply_to_message.text.split('\n')[0].replace('Lưu UID:', '').trim();
            const parts = text.split('|').map(v => v.trim());
            return addAccount(chatId, uid, parts[0] || 'Chưa đặt tên', parts[1] || '🦦');
        }
        return; // Không chạy AI nếu đang reply
    }

    const waitMsg = await safeSend(chatId, '🧠 _AI đang phân tích yêu cầu..._');

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo", 
            messages: [
                {
                    role: "system",
                    content: `Bạn là trợ lý ảo hỗ trợ quản lý tài khoản Facebook.
Nhiệm vụ: Trích xuất thông tin người dùng yêu cầu thành định dạng JSON.
Các action hợp lệ: "add_account", "check_status", "ignore".
Luôn tìm tất cả UID (dãy số dài) có trong câu. Nếu không có tên, gán name: "Chưa đặt tên". Nếu không có ghi chú, gán note: "🦦".
Định dạng JSON bắt buộc (Không giải thích thêm):
{
  "action": "add_account",
  "data": [
    { "uid": "10001...", "name": "Tên", "note": "Ghi chú" }
  ]
}`
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });

        const aiResult = JSON.parse(response.choices[0].message.content);
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

        if (aiResult.action === 'add_account' && aiResult.data && aiResult.data.length > 0) {
            safeSend(chatId, `🤖 AI nhận diện được **${aiResult.data.length}** UID. Đang tiến hành thêm...`);
            for (const acc of aiResult.data) {
                const uid = extractUID(acc.uid);
                if (uid) await addAccount(chatId, uid, acc.name, acc.note);
            }
        } else if (aiResult.action === 'check_status') {
            safeSend(chatId, `🤖 Bạn gõ lệnh /status để xem tổng quan nhé!`);
        }
    } catch (error) {
        bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    }
});

// ================= QUẢN LÝ BUTTONS =================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startsWith('save_')) {
        // FIX NÚT BẤM "Lưu UID" -> Chuyển thành form reply điền Tên | Note dễ dàng
        const uid = data.split('_')[1];
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `Lưu UID: ${uid}\nVui lòng nhập Tên và Ghi chú theo định dạng:\n\`Tên | Ghi chú\``, { 
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
        bot.answerCallbackQuery(query.id, { text: '🗑 Đã xóa UID', show_alert: true });
        bot.deleteMessage(chatId, msgId).catch(() => {});
    }
});

// ================= LIST & DEL & STATUS =================
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
                        const liveText = `🌿 *FACEBOOK ĐÃ LIVE LẠI*\n🆔 \`${row.uid}\` đang LIVE ✅\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${now}`;
                        const opts = {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` }, { text: '🛑 Dừng theo dõi', callback_data: `pause_${row.uid}` }],
                                    [{ text: '❌ Xóa UID', callback_data: `delete_${row.uid}` }]
                                ]
                            }
                        };
                        await safeSend(row.chat_id, liveText, opts);
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
