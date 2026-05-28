require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');

// Khởi tạo Bot và OpenAI
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_ID = process.env.ADMIN_ID;

const userState = {}; 

// Biến lưu trữ Cookie và Token (Ưu tiên lấy từ .env nếu có, hoặc nạp qua bot)
let FB_COOKIE = process.env.FB_COOKIE || "";
let FB_TOKEN = process.env.FB_TOKEN || "";

// Khởi tạo Database SQLite
const db = new sqlite3.Database('./bot_data.sqlite', (err) => {
    if (err) console.error('Lỗi mở database:', err.message);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS uids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT,
            uid TEXT,
            note TEXT,
            status TEXT
        )`);
        console.log('✅ Đã kết nối Database SQLite. Hệ thống lưu trữ thời gian thực sẵn sàng.');
    }
});

// ==========================================
// 1. SETUP MENU
// ==========================================
const botCommands = [
    { command: 'start', description: 'Khởi động bot' },
    { command: 'menu', description: 'Bắt Đầu' },
    { command: 'check', description: 'Check Thông Tin Facebook Full' },
    { command: 'cookie', description: 'Nạp Cookie & Token Admin' },
    { command: 'addytb', description: 'Thêm kênh YouTube theo dõi' },
    { command: 'listytb', description: 'Danh sách kênh YouTube' },
    { command: 'delytb', description: 'Xóa kênh YouTube' },
    { command: 'addpost', description: 'Thêm Post FB theo dõi LIVE/DIE' },
    { command: 'listpost', description: 'Danh sách Post FB đang theo dõi' },
    { command: 'removepost', description: 'Xóa Post FB khỏi theo dõi' },
    { command: 'statuspost', description: 'Check ngay trạng thái Post FB' },
    { command: 'free', description: 'Tặng VIP (Admin)' },
    { command: 'freeall', description: 'Tặng VIP cho tất cả (Admin)' },
    { command: 'panel', description: 'Bảng quản trị (Admin)' }
];
bot.setMyCommands(botCommands);

// ==========================================
// 2. LOGIC CHECK UID VỚI COOKIE & TOKEN
// ==========================================
async function checkFacebookUID(uid) {
    try {
        // ƯU TIÊN 1: Dùng Graph API với Token (Nhanh, hiển thị dạng khóa)
        if (FB_TOKEN) {
            try {
                const apiRes = await axios.get(`https://graph.facebook.com/v18.0/${uid}?access_token=${FB_TOKEN}`, {
                    validateStatus: () => true
                });
                
                if (apiRes.status === 200 && apiRes.data.id) {
                    return { uid: uid, status: 'LIVE', type: 'Normal (API)' };
                } else if (apiRes.data.error) {
                    const errMsg = apiRes.data.error.message.toLowerCase();
                    if (errMsg.includes("checkpoint") || errMsg.includes("temporarily locked")) {
                        return { uid: uid, status: 'DIE', type: 'Checkpoint (282/956)' };
                    }
                    return { uid: uid, status: 'DIE', type: 'FAQ/Disabled (API)' };
                }
            } catch (apiErr) {
                console.log("Lỗi Graph API, chuyển sang dùng Cookie...");
            }
        }

        // ƯU TIÊN 2: Crawl bằng Cookie nếu không có Token hoặc Token hết hạn
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        };
        
        if (FB_COOKIE) {
            headers['Cookie'] = FB_COOKIE;
        }

        const response = await axios.get(`https://www.facebook.com/profile.php?id=${uid}`, {
            headers: headers,
            validateStatus: () => true 
        });

        const html = response.data;
        
        if (response.status === 404 || 
            html.includes("Trang này không khả dụng") || 
            html.includes("This page isn't available") || 
            html.includes("broken_link")) {
            return { uid: uid, status: 'DIE', type: 'FAQ/Ẩn' };
        }

        if (html.includes("checkpoint") || html.includes("temporarily locked")) {
            return { uid: uid, status: 'DIE', type: 'Checkpoint' };
        }

        return { uid: uid, status: 'LIVE', type: 'Normal' };

    } catch (error) {
        return { uid: uid, status: 'DIE', type: 'Timeout/Blocked' };
    }
}

// ==========================================
// 3. XỬ LÝ LỆNH (COMMANDS) & TIN NHẮN
// ==========================================
bot.onText(/\/(start|menu)/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Chào mừng bạn! Vui lòng chọn tính năng từ Menu bên dưới góc trái màn hình.");
});

bot.onText(/\/check/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { action: 'WAITING_FOR_UID' };
    bot.sendMessage(chatId, "📩 Vui lòng nhập UID Hoặc URL:");
});

bot.onText(/\/cookie/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        return bot.sendMessage(chatId, "⛔ Bạn không có quyền thực hiện lệnh này.");
    }
    userState[chatId] = { action: 'WAITING_FOR_CREDENTIALS' };
    bot.sendMessage(chatId, "🛠 *Cập nhật Cookie & Token*\n\nVui lòng gửi dữ liệu theo định dạng sau (ngăn cách bởi dấu `|`):\n\n`[COOKIE] | [TOKEN]`\n\nVí dụ: `sb=xxx;c_user=123... | EAAAAU...`", { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return; 

    // Xử lý nạp Cookie & Token
    if (userState[chatId] && userState[chatId].action === 'WAITING_FOR_CREDENTIALS') {
        const textData = text.trim();
        delete userState[chatId]; 

        if (textData.includes('|')) {
            const parts = textData.split('|');
            FB_COOKIE = parts[0].trim();
            FB_TOKEN = parts[1].trim();
            
            bot.sendMessage(chatId, "✅ *Đã cập nhật Cookie và Token thành công!*\nHệ thống Check sẽ tự động sử dụng cấu hình mới.", { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, "❌ Sai định dạng! Vui lòng dùng lệnh /cookie và nhập lại đúng định dạng: `Cookie | Token`", { parse_mode: 'Markdown' });
        }
        return;
    }

    // Xử lý Check UID
    if (userState[chatId] && userState[chatId].action === 'WAITING_FOR_UID') {
        const targetUid = text.trim();
        delete userState[chatId]; 

        bot.sendMessage(chatId, "⏳ Đang kiểm tra UID, vui lòng đợi...");
        
        const checkResult = await checkFacebookUID(targetUid);

        let responseMsg = '';
        if (checkResult.status === 'DIE') {
            responseMsg = `❌ UID ${targetUid} đã DIE.\n⚠️ Die Dạng: ${checkResult.type}\n\n📌 Bạn có muốn lưu UID này không?`;
        } else {
            responseMsg = `✅ UID ${targetUid} đang LIVE.\n\n📌 Bạn có muốn lưu UID này không?`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Lưu UID', callback_data: `saveuid_${targetUid}` },
                    { text: '❌ Bỏ qua', callback_data: 'ignoreuid' }
                ],
                [
                    { text: '🔄 Check lại', callback_data: `recheck_${targetUid}` }
                ]
            ]
        };

        return bot.sendMessage(chatId, responseMsg, { reply_markup: keyboard });
    }

    // Tích hợp AI (Hỗ trợ code & ngôn ngữ)
    try {
        bot.sendChatAction(chatId, 'typing');
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "Bạn là trợ lý AI. Chỉ trả lời các câu hỏi về lập trình, dịch thuật và thông thường. Bỏ qua các yêu cầu liên quan đến check UID Facebook."
                },
                { role: "user", content: text }
            ],
        });
        bot.sendMessage(chatId, completion.choices[0].message.content, { parse_mode: "Markdown" });
    } catch (error) {
        bot.sendMessage(chatId, "⚠️ AI đang bận hoặc lỗi kết nối.");
    }
});

// ==========================================
// 4. XỬ LÝ NÚT BẤM VÀ THEO DÕI (REAL-TIME)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    // LƯU UID ĐỂ THEO DÕI
    if (data.startsWith('saveuid_')) {
        const uid = data.split('_')[1];
        db.run(`INSERT INTO uids (chat_id, uid, note, status) VALUES (?, ?, ?, ?)`, [chatId, uid, 'dame dạo', 'TRACKING'], function(err) {
            if (err) return bot.answerCallbackQuery(query.id, { text: "Lỗi khi lưu UID!" });
            
            const timeNow = new Date().toLocaleString('vi-VN');
            const alertMsg = `🍂 ${uid} đã được đưa vào danh sách theo dõi.\n👤 Tài Khoản: dame dạo\n📝 Ghi Chú: 🦦\n⏰ Thời Gian: ${timeNow}`;
            
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${uid}` },
                        { text: '🛑 Dừng theo dõi', callback_data: `stop_${uid}` }
                    ],
                    [
                        { text: '❌ Xóa UID', callback_data: `del_${uid}` }
                    ]
                ]
            };
            bot.editMessageText(alertMsg, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
        });
    }

    // CHECK LẠI NGAY LẬP TỨC
    if (data.startsWith('recheck_')) {
        const targetUid = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: "Đang kiểm tra lại..." });
        
        const checkResult = await checkFacebookUID(targetUid);
        let responseMsg = checkResult.status === 'DIE' 
            ? `❌ UID ${targetUid} đã DIE.\n⚠️ Die Dạng: ${checkResult.type}\n\n📌 Bạn có muốn lưu UID này không?`
            : `✅ UID ${targetUid} đang LIVE.\n\n📌 Bạn có muốn lưu UID này không?`;
            
        bot.editMessageText(responseMsg, { 
            chat_id: chatId, 
            message_id: messageId, 
            reply_markup: query.message.reply_markup 
        });
    }

    if (data === 'ignoreuid') {
        bot.deleteMessage(chatId, messageId).catch(console.error);
    }

    if (data.startsWith('del_')) {
        const uid = data.split('_')[1];
        db.run(`DELETE FROM uids WHERE chat_id = ? AND uid = ?`, [chatId, uid], (err) => {
            if (!err) {
                bot.editMessageText(`✅ Đã xóa UID ${uid} khỏi hệ thống theo dõi!`, { chat_id: chatId, message_id: messageId });
            }
        });
    }

    if (data.startsWith('stop_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE uids SET status = 'STOPPED' WHERE chat_id = ? AND uid = ?`, [chatId, uid]);
        bot.answerCallbackQuery(query.id, { text: "Đã tạm dừng theo dõi UID này." });
    }

    if (data.startsWith('continue_')) {
        const uid = data.split('_')[1];
        db.run(`UPDATE uids SET status = 'TRACKING' WHERE chat_id = ? AND uid = ?`, [chatId, uid]);
        bot.answerCallbackQuery(query.id, { text: "Đã bật lại theo dõi UID này." });
    }
});

// ==========================================
// 5. CRON JOB: THEO DÕI REAL-TIME 
// ==========================================
// Chạy mỗi 5 phút để quét các UID đang ở trạng thái 'TRACKING'
cron.schedule('*/5 * * * *', () => {
    db.all(`SELECT * FROM uids WHERE status = 'TRACKING'`, [], async (err, rows) => {
        if (err || !rows) return;
        
        for (const row of rows) {
            const checkResult = await checkFacebookUID(row.uid);
            
            // Nếu phát hiện chuyển từ LIVE sang DIE (hoặc vẫn DIE trong danh sách theo dõi)
            if (checkResult.status === 'DIE') {
                const timeNow = new Date().toLocaleString('vi-VN');
                const alertMsg = `🍂 ${row.uid} đã DIE ❌\n👤 Tài Khoản: ${row.note}\n📝 Ghi Chú: 🦦\n⏰ Thời Gian: ${timeNow}`;
                
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '🔄 Tiếp tục theo dõi', callback_data: `continue_${row.uid}` },
                            { text: '🛑 Dừng theo dõi', callback_data: `stop_${row.uid}` }
                        ],
                        [
                            { text: '❌ Xóa UID', callback_data: `del_${row.uid}` }
                        ]
                    ]
                };
                
                bot.sendMessage(row.chat_id, alertMsg, { reply_markup: keyboard });
                
                // Đổi trạng thái thành DIE để Cron Job không spam tin nhắn mỗi 5 phút
                db.run(`UPDATE uids SET status = 'DIE' WHERE id = ?`, [row.id]); 
            }
        }
    });
});
