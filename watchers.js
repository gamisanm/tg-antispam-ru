const fs = require('fs');
const path = require('path');

const WATCHERS_FILE = path.join(__dirname, 'watchers.json');
// A watcher loses /delete after this many deletions the owner reverted
const MAX_MISTAKES = 3;
// Deletions per watcher per hour; past that /delete falls back to a report
const HOURLY_LIMIT = 10;

// Night watchers: trusted members who may /delete without a ban. The owner
// approves each deletion later; reverted ones count as mistakes.
class Watchers {
    constructor() {
        this.list = {};
        try {
            this.list = JSON.parse(fs.readFileSync(WATCHERS_FILE, 'utf8'));
        } catch (e) {
            // First run or corrupt file — start with no watchers
            this.list = {};
        }
        // userId → timestamps of recent deletions (in memory; resets on restart)
        this.recent = new Map();
    }

    save() {
        try {
            fs.writeFileSync(WATCHERS_FILE, JSON.stringify(this.list, null, 2));
        } catch (e) {
            console.error('Error saving watchers:', e);
        }
    }

    add(userId) {
        const w = this.list[userId] || { ok: 0, mistakes: 0 };
        w.disabled = false;
        w.mistakes = 0;
        this.list[userId] = w;
        this.save();
    }

    remove(userId) {
        const existed = Boolean(this.list[userId]);
        delete this.list[userId];
        this.save();
        return existed;
    }

    isWatcher(userId) {
        return Boolean(this.list[userId]);
    }

    isActive(userId) {
        const w = this.list[userId];
        return Boolean(w && !w.disabled);
    }

    // Records a deletion attempt; false when the hourly limit is used up
    takeQuota(userId) {
        const now = Date.now();
        const times = (this.recent.get(userId) || []).filter(t => now - t < 60 * 60 * 1000);
        if (times.length >= HOURLY_LIMIT) return false;
        times.push(now);
        this.recent.set(userId, times);
        return true;
    }

    recordCorrect(userId) {
        const w = this.list[userId];
        if (!w) return;
        w.ok++;
        this.save();
    }

    // Returns true if this mistake disabled the watcher
    recordMistake(userId) {
        const w = this.list[userId];
        if (!w) return false;
        w.mistakes++;
        const disabledNow = !w.disabled && w.mistakes >= MAX_MISTAKES;
        if (disabledNow) w.disabled = true;
        this.save();
        return disabledNow;
    }

    accuracy(userId) {
        const w = this.list[userId];
        if (!w) return '';
        return `${w.ok} из ${w.ok + w.mistakes}`;
    }
}

module.exports = Watchers;
module.exports.MAX_MISTAKES = MAX_MISTAKES;
module.exports.HOURLY_LIMIT = HOURLY_LIMIT;
