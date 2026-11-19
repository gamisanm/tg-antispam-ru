const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const MessageHandler = require('./messageHandler');

let bot;
let messageHandler;

try {
    bot = new TelegramBot(config.token, { 
        polling: true,
        polling_interval: 300,
        webHook: false
    });
    
    messageHandler = new MessageHandler(bot);

    // Register event handlers
    bot.on('new_chat_members', msg => messageHandler.handleNewMember(msg));
    bot.on('left_chat_member', msg => messageHandler.handleLeftMember(msg));
    bot.on('message', msg => messageHandler.handleMessage(msg));
    // Spammers often post innocent text, then edit it into spam — re-check edits
    bot.on('edited_message', msg => messageHandler.handleEditedMessage(msg));
    bot.on('callback_query', query => messageHandler.handleCallback(query));

    console.log(`Bot started successfully! Rules version: ${MessageHandler.RULES_VERSION}`);
} catch (error) {
    console.error('Error creating bot:', error);
    process.exit(1);
}

// Handle process termination
process.on('SIGINT', () => {
    messageHandler.reputation.save();
    bot.stopPolling();
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    // Give some time for logs to be written
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
