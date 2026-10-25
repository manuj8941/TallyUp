require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, useTurso } = require('../db/connection');
const { initializeDatabase } = require('../db/database');
const { accrueLeavesForUserOnStartup } = require('../services/leaveAccrual');

async function resetFresh() {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('🧹 TALLYUP FRESH DATABASE & ASSET RESET');
    console.log('   Re-initializing clean database schema, indexes, and seeded state');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    // 1. Drop existing database tables
    console.log('1️⃣ Dropping existing database tables...');
    const tablesToDrop = ['attendance', 'leaves', 'ad_hoc_offs', 'holidays', 'settings', 'users'];
    
    // Also find any legacy tables
    const legacy = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'attendance_%'");
    const allDrop = [...tablesToDrop, ...(legacy || []).map(l => l.name)];

    for (const tbl of allDrop) {
        try {
            await db.run(`DROP TABLE IF EXISTS ${tbl}`);
            console.log(`   Dropped table: ${tbl}`);
        } catch (e) {
            console.warn(`   Notice dropping ${tbl}:`, e.message);
        }
    }

    // 2. Clean up local selfies & uploaded test files
    console.log('\n2️⃣ Cleaning up local selfies & asset directories...');
    const selfiesDir = path.join(__dirname, '..', 'selfies');
    if (fs.existsSync(selfiesDir)) {
        const entries = fs.readdirSync(selfiesDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(selfiesDir, entry.name);
            if (entry.isDirectory()) {
                fs.rmSync(entryPath, { recursive: true, force: true });
                fs.mkdirSync(entryPath, { recursive: true });
                console.log(`   Cleared user selfie folder: selfies/${entry.name}`);
            } else if (entry.isFile()) {
                fs.unlinkSync(entryPath);
            }
        }
    }

    // 3. Re-initialize database with fresh schemas, columns, indexes, and seeds
    console.log('\n3️⃣ Initializing fresh schema & indexes...');
    const dummyApp = express();
    dummyApp.locals = {};
    await initializeDatabase(dummyApp, accrueLeavesForUserOnStartup);

    // 4. Verify all tables, columns and indexes
    console.log('\n4️⃣ Verifying database integrity...');
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    console.log('   Active Tables:', tables.map(t => t.name).join(', '));

    const userCols = await db.all("PRAGMA table_info(users)");
    console.log('   `users` columns:', userCols.map(c => c.name).join(', '));

    const attCols = await db.all("PRAGMA table_info(attendance)");
    console.log('   `attendance` columns:', attCols.map(c => c.name).join(', '));

    const leaveCols = await db.all("PRAGMA table_info(leaves)");
    console.log('   `leaves` columns:', leaveCols.map(c => c.name).join(', '));

    const indexes = await db.all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'");
    console.log('   Indexes created:', indexes.map(i => i.name).join(', '));

    const seededUsers = await db.all("SELECT name, role, is_active FROM users");
    console.log(`   Seeded users (${seededUsers.length}):`, seededUsers.map(u => `${u.name} (${u.role}, active=${u.is_active})`).join(', '));

    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('✨ FRESH DATABASE RESET COMPLETE!');
    console.log('═══════════════════════════════════════════════════════════════════════\n');
    process.exit(0);
}

resetFresh().catch(err => {
    console.error('Fatal reset error:', err);
    process.exit(1);
});
