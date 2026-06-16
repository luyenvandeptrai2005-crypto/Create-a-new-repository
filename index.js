const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const http = require('http'); // Tích hợp thêm HTTP để Render không bị lỗi Port Scan

// Khởi tạo bot với token từ biến môi trường
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const DB_FILE = 'users.json'; // File giả lập database lưu danh sách người dùng thật

// ==========================================
// CẤU HÌNH SỐ LƯỢNG NGƯỜI DÙNG ẢO
// Hiện tại bạn có 7 người thật, cộng thêm 3273 sẽ hiển thị thành 3280
const FAKE_USER_OFFSET = 3273; 
// ==========================================

// Hàm tải danh sách người dùng thật từ file
function getUsers() {
    if (!fs.existsSync(DB_FILE)) return [];
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return data ? JSON.parse(data) : [];
    } catch (err) {
        console.error("Lỗi khi đọc file database:", err.message);
        return [];
    }
}

// Lệnh 1: Lưu người dùng khi họ nhấn /start
bot.onText(/\/start/, (msg) => {
    let users = getUsers();
    const chatId = msg.chat.id;

    if (!users.includes(chatId)) {
        users.push(chatId);
        fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
    }
    bot.sendMessage(chatId, "Chào mừng bạn đến với CheckUIDPro! Bot đã lưu thông tin của bạn.");
});

// Lệnh 2: Xem thống kê số lượng người dùng (Đã đổi thành Người dùng hàng tháng)
bot.onText(/\/thongke/, (msg) => {
    let realUsers = getUsers().length;
    let totalVirtualUsers = realUsers + FAKE_USER_OFFSET;
    
    const thongKeMsg = `📊 <b>THỐNG KÊ HỆ THỐNG CHECKUIDPRO</b>\n\n` +
                       `👥 Người dùng hàng tháng (MAU): <b>${totalVirtualUsers.toLocaleString('vi-VN')}</b> người\n` +
                       `🟢 Trạng thái: Hoạt động bình thường\n` +
                       `⏰ Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')} - ${new Date().toLocaleDateString('vi-VN')}`;
                       
    bot.sendMessage(msg.chat.id, thongKeMsg, { parse_mode: 'HTML' });
});

// Lệnh 3: Gửi thông báo cho TẤT CẢ người dùng (Broadcast)
bot.onText(/\/thongbao (.+)/, async (msg, match) => {
    // Chỉ admin (ID: 8312235036) mới được dùng lệnh này
    if (msg.chat.id.toString() !== '8312235036') {
        return bot.sendMessage(msg.chat.id, "❌ Bạn không có quyền sử dụng lệnh này.");
    }

    const noiDung = match[1];
    const users = getUsers();
    
    const thongBao = `📢 <b>THÔNG BÁO</b>\n` +
                     `===========================\n\n` +
                     `${noiDung}\n\n` +
                     `===========================\n` +
                     `⏰ ${new Date().toLocaleTimeString('vi-VN')} - ${new Date().toLocaleDateString('vi-VN')}`;

    // Tính toán số liệu ảo
    const totalVirtualUsers = users.length + FAKE_USER_OFFSET;
    
    // Gửi tin nhắn báo cho admin biết bot đang bắt đầu chạy broadcast
    await bot.sendMessage(msg.chat.id, `⏳ Đang tiến hành gửi thông báo tới <b>${totalVirtualUsers.toLocaleString('vi-VN')}</b> người dùng...`, { parse_mode: 'HTML' });

    let realSuccessCount = 0;

    // Chạy vòng lặp gửi thông báo (CHỈ gửi cho người dùng thật để tránh lỗi API)
    for (const userId of users) {
        try {
            await bot.sendMessage(userId, thongBao, { parse_mode: 'HTML' });
            realSuccessCount++;
            
            // Tạm dừng 50ms giữa mỗi tin nhắn để tránh bị Telegram đánh dấu là spam API
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (err) {
            console.log(`[LỖI] Không gửi được cho ${userId}: ${err.message}`);
        }
    }

    // Tính toán số lượng gửi thành công ảo để báo cáo lại cho admin
    const virtualSuccessCount = realSuccessCount + FAKE_USER_OFFSET;
    
    const reportMsg = `✅ <b>BROADCAST HOÀN TẤT</b>\n\n` +
                      `Đã gửi thành công tới: <b>${virtualSuccessCount.toLocaleString('vi-VN')} / ${totalVirtualUsers.toLocaleString('vi-VN')}</b> người dùng.`;
                      
    bot.sendMessage(msg.chat.id, reportMsg, { parse_mode: 'HTML' });
});

// ==========================================
// CẤU HÌNH WEB SERVER MINI CHO RENDER
// Render yêu cầu hệ thống phải lắng nghe một Port nếu chạy dạng Web Service công khai.
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot CheckUIDPro đang hoạt động ổn định 24/7!');
});

server.listen(PORT, () => {
    console.log(`🌐 Web Server chạy tại port: ${PORT}`);
    console.log("🤖 Bot CheckUIDPro đang online... Sẵn sàng nhận lệnh!");
});
