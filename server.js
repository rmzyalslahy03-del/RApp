const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // 10 MB limit for file transfers
});

// ========== 1. إعداد SQLite (قاعدة بيانات المستخدمين المركزية) ==========
let db;

async function initDatabase() {
    db = await open({
        filename: './usersramz.db',
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ SQLite server database ready (usersramz.db)');

    // ========== إنشاء المستخدمين التجريبيين (رمزي، شعلان) ==========
    const testUsers = [
        { username: 'رمزي', password: '654321' },
        { username: 'شعلان', password: '654321' }
    ];
    for (const user of testUsers) {
        const existing = await db.get('SELECT id FROM users WHERE username = ?', [user.username]);
        if (!existing) {
            const hashedPassword = await bcrypt.hash(user.password, 10);
            await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [user.username, hashedPassword]);
            console.log(`✅ تم إنشاء مستخدم تجريبي: ${user.username}`);
        } else {
            console.log(`ℹ️ المستخدم التجريبي موجود بالفعل: ${user.username}`);
        }
    }
}
initDatabase().catch(err => console.error('❌ Database init error:', err));

// ========== 2. Middleware ==========
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 3. API routes (تسجيل الدخول والتسجيل) ==========
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hashedPassword]);
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
        } else {
            console.error(err);
            res.status(500).json({ error: 'خطأ في الخادم' });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get('SELECT password_hash FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(401).json({ error: 'اسم المستخدم غير صحيح' });
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
        }
        res.json({ success: true, username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ========== 4. Fallback route: أي مسار لا يبدأ بـ /api يرسل index.html ==========
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 5. Socket.io (الاتصال الفوري) ==========
// تخزين المستخدمين المتصلين و socket id الخاص بهم
const onlineUsers = new Map(); // username -> socket.id

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('user_online', (username) => {
        currentUser = username;
        onlineUsers.set(username, socket.id);
        socket.broadcast.emit('user_status', { username, status: 'online' });
        console.log(`✅ ${username} online`);
    });

    // إرسال رسالة نصية
    socket.on('send_message', (data) => {
        const { sender, receiver, messageId, content, time } = data;
        const receiverSocket = onlineUsers.get(receiver);
        if (receiverSocket) {
            io.to(receiverSocket).emit('receive_message', {
                sender, receiver, messageId, content, time, type: 'text'
            });
            // إشعار بالإرسال للمرسل بأن الرسالة وصلت للخادم (يمكن تحسينه)
            socket.emit('message_delivered', { messageId });
        } else {
            socket.emit('message_error', { messageId, error: 'المستلم غير متصل' });
        }
    });

    // إرسال ملف (ArrayBuffer)
    socket.on('send_file', (data) => {
        const { sender, receiver, messageId, fileName, fileId, fileType, fileSize, time, data: fileData } = data;
        const receiverSocket = onlineUsers.get(receiver);
        if (receiverSocket) {
            io.to(receiverSocket).emit('receive_file', {
                sender, receiver, messageId, fileName, fileId, fileType, fileSize, time, data: fileData
            });
            socket.emit('message_delivered', { messageId });
        } else {
            socket.emit('message_error', { messageId, error: 'المستلم غير متصل' });
        }
    });

    // إيصال الاستلام (delivered) يتم إرساله تلقائياً عند استلام الرسالة
    // يمكن للعميل إرسال read_receipt عند قراءة الرسالة
    socket.on('read_receipt', ({ sender, receiver, messageId }) => {
        const senderSocket = onlineUsers.get(sender);
        if (senderSocket) {
            io.to(senderSocket).emit('message_read', { messageId, reader: receiver });
        }
    });

    // مؤشر الكتابة
    socket.on('typing', ({ sender, receiver, isTyping }) => {
        const receiverSocket = onlineUsers.get(receiver);
        if (receiverSocket) {
            io.to(receiverSocket).emit('typing', { sender, isTyping });
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            socket.broadcast.emit('user_status', { username: currentUser, status: 'offline' });
            console.log(`❌ ${currentUser} offline`);
        }
    });
});

// ========== 6. تشغيل الخادم ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
    console.log(`📁 تقديم الملفات الثابتة من: ${path.join(__dirname, 'public')}`);
    console.log(`👥 مستخدمون تجريبيون: رمزي / 654321 ، شعلان / 654321`);
});
