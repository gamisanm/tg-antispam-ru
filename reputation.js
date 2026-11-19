const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'userStats.json');
const SAVE_INTERVAL_MS = 30000;

// Tracks how many messages each user has posted (per chat) that were NOT deleted.
// Established members get a higher spam-score threshold, new members a stricter one.
class Reputation {
    constructor() {
        this.counts = {};
        this.dirty = false;
        try {
            this.counts = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        } catch (e) {
            // First run or corrupt file — start fresh
            this.counts = {};
        }
        this.timer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
    }

    key(chatId, userId) {
        return `${chatId}:${userId}`;
    }

    messageCount(chatId, userId) {
        return this.counts[this.key(chatId, userId)] || 0;
    }

    recordMessage(chatId, userId) {
        const k = this.key(chatId, userId);
        this.counts[k] = (this.counts[k] || 0) + 1;
        this.dirty = true;
    }

    reset(chatId, userId) {
        delete this.counts[this.key(chatId, userId)];
        this.dirty = true;
    }

    // Bonus added to the spam-score threshold based on user history.
    // 0 for newcomers, +2 after 5 kept messages, +4 after 25.
    thresholdBonus(chatId, userId) {
        const n = this.messageCount(chatId, userId);
        if (n >= 25) return 4;
        if (n >= 5) return 2;
        return 0;
    }

    save() {
        if (!this.dirty) return;
        try {
            fs.writeFileSync(STATS_FILE, JSON.stringify(this.counts));
            this.dirty = false;
        } catch (e) {
            console.error('Error saving user stats:', e);
        }
    }
}

module.exports = Reputation;
