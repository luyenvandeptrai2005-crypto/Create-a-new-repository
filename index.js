const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const DB_FILE = 'users.json'; // File giả lập database lưu danh sách người dùng

// Hàm tải danh sách người dùng
function getUsers() {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE));
}

// 1. Lưu người dùng khi họ nhấn /start
bot.onText(/\/start/, (msg) => {
    let users = getUsers();
    if (!users.includes(msg.chat.id)) {
        users.push(msg.chat.id);
        fs.writeFileSync(DB_FILE, JSON.stringify(users));
    }
    bot.sendMessage(msg.chat.id, "Chào mừng bạn đến với CheckUIDPro! Bot đã lưu thông tin của bạn.");
});

// 2. Lệnh gửi thông báo cho TẤT CẢ người dùng
bot.onText(/\/thongbao (.+)/, async (msg, match) => {
    // Chỉ admin (ID của bạn) mới được dùng lệnh này
    if (msg.chat.id.toString() !== '8312235036') return;

    const noiDung = match[1];
    const users = getUsers();
    
    const thongBao = `📢 <b>THÔNG BÁO</b>\n` +
                     `===========================\n\n` +
                     `${noiDung}\n\n` +
                     `===========================\n` +
                     `⏰ ${new Date().toLocaleTimeString()} - ${new Date().toLocaleDateString()}`;

    // Gửi thông báo hàng loạt (Broadcast)
    for (const userId of users) {
        try {
            await bot.sendMessage(userId, thongBao, { parse_mode: 'HTML' });
        } catch (err) {
            console.log(`Không gửi được cho ${userId}: ${err.message}`);
        }
    }
});
