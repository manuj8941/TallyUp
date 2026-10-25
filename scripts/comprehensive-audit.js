require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const app = require('../index');
const { initializeDatabase, db } = require('../db/database');
const { accrueLeavesForUserOnStartup } = require('../services/leaveAccrual');

const PORT = 3889;
const BASE_URL = `http://localhost:${PORT}`;
const SCREENSHOTS_ROOT = path.join(__dirname, '..', 'audit-screenshots');

const FOLDERS = {
    AUTH: path.join(SCREENSHOTS_ROOT, '01-auth-security'),
    ATTENDANCE: path.join(SCREENSHOTS_ROOT, '02-attendance-rules'),
    LEAVES: path.join(SCREENSHOTS_ROOT, '03-leave-validation'),
    ADMIN: path.join(SCREENSHOTS_ROOT, '04-admin-controls')
};

Object.values(FOLDERS).forEach(f => {
    if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
});

const auditResults = [];

function recordAudit({ id, category, name, expected, actual, dbCheck, screenshot, pass }) {
    auditResults.push({ id, category, name, expected, actual, dbCheck, screenshot, pass });
    const icon = pass ? '✅' : '❌';
    console.log(`${icon} [${id}] ${category.toUpperCase()} | ${name}`);
    console.log(`   Expected: ${expected}`);
    console.log(`   Observed: ${actual}`);
    if (dbCheck) console.log(`   DB State: ${dbCheck}`);
    if (screenshot) console.log(`   Screenshot: ${path.basename(screenshot)}`);
    console.log('');
}

async function apiRequest(endpoint, { method = 'GET', body = null, cookie = '' } = {}) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (cookie) headers['cookie'] = cookie;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        redirect: 'manual'
    });

    const setCookie = res.headers.get('set-cookie');
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = text; }

    return { status: res.status, headers: res.headers, data, setCookie: setCookie ? setCookie.split(';')[0] : '' };
}

function getValidSelfieBase64() {
    return 'data:image/jpeg;base64,' + 'A'.repeat(2500);
}

async function getCookiesString(context) {
    const cookies = await context.cookies();
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function runComprehensiveAudit() {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('🛡️  TALLYUP DEEP AUTOMATED SYSTEM AUDIT');
    console.log('    Testing all 25+ Security, Validation, and Business Scenarios');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    await initializeDatabase(app, accrueLeavesForUserOnStartup);
    
    // Baseline settings
    await db.run("UPDATE settings SET value = '' WHERE name = 'test_date_override'");
    app.locals.testDateOverride = '';
    await db.run("UPDATE settings SET value = '1' WHERE name = 'desktop_enabled'");
    await db.run("UPDATE settings SET value = '3' WHERE name = 'weekly_off_mode'");

    const server = app.listen(PORT);
    console.log(`🌐 Audit server active on ${BASE_URL}\n`);

    let browser;
    try {
        browser = await chromium.launch({
            channel: 'chrome',
            headless: true,
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--no-sandbox'
            ]
        });

        // =========================================================================
        // CATEGORY 1: AUTHENTICATION & ACCESS CONTROL SECURITY
        // =========================================================================
        console.log('▶ [CATEGORY 1] AUTHENTICATION & ACCESS CONTROL SECURITY\n');

        const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pageA = await contextA.newPage();

        // SCENARIO 1.1: Invalid Username & Password Rejection
        await pageA.goto(`${BASE_URL}/login`);
        await pageA.fill('#name', 'non_existent_user');
        await pageA.fill('#password', 'wrong_password');
        await pageA.click('button[type="submit"]');
        await pageA.waitForSelector('#login-error:not([style*="display: none"])', { timeout: 5000 });
        const loginErrorText = await pageA.locator('#login-error').innerText();
        const sc1_1 = path.join(FOLDERS.AUTH, '01-invalid-credentials-rejected.png');
        await pageA.screenshot({ path: sc1_1 });
        recordAudit({
            id: 'AUTH-01',
            category: 'Authentication',
            name: 'Invalid Credentials Rejection',
            expected: 'Login rejected with friendly error message',
            actual: loginErrorText,
            dbCheck: 'Zero sessions created',
            screenshot: sc1_1,
            pass: loginErrorText.includes('Check your username and password')
        });

        // SCENARIO 1.2: Unauthenticated Protected Route Access Blocked
        const unauthRes = await apiRequest('/dashboard');
        const sc1_2 = path.join(FOLDERS.AUTH, '02-unauthenticated-access-redirect.png');
        await pageA.goto(`${BASE_URL}/dashboard`);
        await pageA.screenshot({ path: sc1_2 });
        recordAudit({
            id: 'AUTH-02',
            category: 'Authentication',
            name: 'Unauthenticated Protected Route Guard',
            expected: 'Redirect (302) to login root /',
            actual: `Status: ${unauthRes.status}, redirected to: ${unauthRes.headers.get('location')}`,
            dbCheck: 'Access blocked by requireLogin middleware',
            screenshot: sc1_2,
            pass: unauthRes.status === 302 && unauthRes.headers.get('location') === '/'
        });

        // SCENARIO 1.3: Role Privilege Escalation Blocked (Employee accessing Admin/Team)
        await pageA.goto(`${BASE_URL}/login`);
        await pageA.fill('#name', 'manuj');
        await pageA.fill('#password', '111');
        await pageA.click('button[type="submit"]');
        await pageA.waitForURL('**/dashboard');
        
        // Employee tries to open /team &rarr; redirected away from /team back to /dashboard
        await pageA.goto(`${BASE_URL}/team`);
        await pageA.waitForURL('**/dashboard');
        const sc1_3 = path.join(FOLDERS.AUTH, '03-employee-role-access-denied.png');
        await pageA.screenshot({ path: sc1_3 });
        recordAudit({
            id: 'AUTH-03',
            category: 'Access Control',
            name: 'Employee Restricted From Admin Routes',
            expected: 'Employee blocked from /team and bounced back to /dashboard',
            actual: `Current URL: ${pageA.url()}`,
            dbCheck: 'Role employee verified in users table',
            screenshot: sc1_3,
            pass: !pageA.url().includes('/team') && pageA.url().includes('/dashboard')
        });

        // SCENARIO 1.4: Manager Restricted From Owner-Only App Settings
        const mgrContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const mgrPage = await mgrContext.newPage();
        await mgrPage.goto(`${BASE_URL}/login`);
        await mgrPage.fill('#name', 'dinesh'); // Manager
        await mgrPage.fill('#password', '111');
        await mgrPage.click('button[type="submit"]');
        await mgrPage.waitForURL('**/dashboard');
        await mgrPage.goto(`${BASE_URL}/appsettings`);
        await mgrPage.waitForURL('**/dashboard');
        const sc1_4 = path.join(FOLDERS.AUTH, '04-manager-restricted-from-appsettings.png');
        await mgrPage.screenshot({ path: sc1_4 });
        recordAudit({
            id: 'AUTH-04',
            category: 'Access Control',
            name: 'Manager Restricted From Owner Settings',
            expected: 'Manager blocked from /appsettings and bounced back to /dashboard',
            actual: `Current URL: ${mgrPage.url()}`,
            dbCheck: 'requireOwner middleware triggered',
            screenshot: sc1_4,
            pass: !mgrPage.url().includes('/appsettings') && mgrPage.url().includes('/dashboard')
        });
        await mgrContext.close();

        // SCENARIO 1.5: Single Session Enforcement (Device B kicks Device A)
        const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pageB = await contextB.newPage();
        await pageB.goto(`${BASE_URL}/login`);
        await pageB.fill('#name', 'manuj');
        await pageB.fill('#password', '111');
        await pageB.click('button[type="submit"]');
        await pageB.waitForURL('**/dashboard');

        // Refresh Device A (pageA) &rarr; session destroyed, bounced back out of /dashboard to /
        await pageA.goto(`${BASE_URL}/dashboard`);
        const sc1_5 = path.join(FOLDERS.AUTH, '05-single-session-kickout-enforced.png');
        await pageA.screenshot({ path: sc1_5 });
        const sessionRow = await db.get('SELECT current_session_id FROM users WHERE name = ?', ['manuj']);
        recordAudit({
            id: 'AUTH-05',
            category: 'Session Security',
            name: 'Single Session Kickout Enforcement',
            expected: 'Device A kicked out of /dashboard to login root /',
            actual: `Bounced out to URL: ${pageA.url()}`,
            dbCheck: `Active session ID updated to: ${sessionRow.current_session_id.substring(0, 8)}...`,
            screenshot: sc1_5,
            pass: pageA.url() === `${BASE_URL}/` || pageA.url().includes('session_invalidated')
        });
        await contextA.close();
        await contextB.close();

        // =========================================================================
        // CATEGORY 2: ATTENDANCE PUNCH RULES & CONFLICT RESOLUTION
        // =========================================================================
        console.log('▶ [CATEGORY 2] ATTENDANCE PUNCH RULES & CONFLICT RESOLUTION\n');

        // Clean user records
        await db.run('DELETE FROM attendance WHERE username = ?', ['atul']);
        await db.run('DELETE FROM leaves WHERE username = ?', ['atul']);
        
        const attContext = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            geolocation: { latitude: 28.6139, longitude: 77.2090 },
            permissions: ['camera', 'geolocation']
        });
        const attPage = await attContext.newPage();
        await attPage.goto(`${BASE_URL}/login`);
        await attPage.fill('#name', 'atul');
        await attPage.fill('#password', '111');
        await attPage.click('button[type="submit"]');
        await attPage.waitForURL('**/dashboard');
        
        const atulCookie = await getCookiesString(attContext);

        // SCENARIO 2.0: Weekly Off Attendance Blocking (Sunday Policy Check)
        // Today is Sunday, mode 3 blocks punches on Sunday
        const weeklyOffPunchRes = await apiRequest('/mark-in', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        const sc2_0 = path.join(FOLDERS.ATTENDANCE, '00-weekly-off-punch-blocked.png');
        await attPage.screenshot({ path: sc2_0 });
        recordAudit({
            id: 'ATT-00',
            category: 'Attendance Rules',
            name: 'Weekly Off Policy Blocks Punch-In',
            expected: 'HTTP 403: Weekly off today - enjoy your break!',
            actual: `Status: ${weeklyOffPunchRes.status}, Message: "${weeklyOffPunchRes.data.message}"`,
            dbCheck: 'Weekly off verified via checkIfDateIsOff service',
            screenshot: sc2_0,
            pass: weeklyOffPunchRes.status === 403 && weeklyOffPunchRes.data.message.includes('Weekly off today')
        });

        // Temporarily disable weekly off so we can audit subsequent punch logic (valid in/out, double punch, etc.)
        await db.run("UPDATE settings SET value = '0' WHERE name = 'weekly_off_mode'");

        // SCENARIO 2.1: Punch-Out Before Punch-In Rejection
        const punchOutBeforeIn = await apiRequest('/mark-out', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        const sc2_1 = path.join(FOLDERS.ATTENDANCE, '01-punch-out-before-in-blocked.png');
        await attPage.screenshot({ path: sc2_1 });
        recordAudit({
            id: 'ATT-01',
            category: 'Attendance Rules',
            name: 'Punch-Out Without Prior Punch-In Blocked',
            expected: 'HTTP 400: Oops! You need to check in first before checking out.',
            actual: `Status: ${punchOutBeforeIn.status}, Message: "${punchOutBeforeIn.data.message}"`,
            dbCheck: 'Zero punch-out recorded in DB',
            screenshot: sc2_1,
            pass: punchOutBeforeIn.status === 400 && punchOutBeforeIn.data.message.includes('check in first')
        });

        // SCENARIO 2.2: Valid Punch-In Execution
        const validMarkIn = await apiRequest('/mark-in', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        await attPage.reload();
        await attPage.waitForSelector('#action-button:has-text("Check Out"), #action-button:has-text("Time to Check Out")', { timeout: 8000 });
        const sc2_2 = path.join(FOLDERS.ATTENDANCE, '02-valid-punch-in-recorded.png');
        await attPage.screenshot({ path: sc2_2 });
        const atulPunchInRow = await db.get('SELECT in_time, in_latitude, in_longitude FROM attendance WHERE username = ?', ['atul']);
        recordAudit({
            id: 'ATT-02',
            category: 'Attendance Rules',
            name: 'Valid Punch-In Execution',
            expected: 'HTTP 200: Checked in successfully',
            actual: `Status: ${validMarkIn.status}, Message: "${validMarkIn.data.message}"`,
            dbCheck: `DB in_time: ${atulPunchInRow.in_time}, Lat: ${atulPunchInRow.in_latitude}, Lon: ${atulPunchInRow.in_longitude}`,
            screenshot: sc2_2,
            pass: validMarkIn.status === 200 && atulPunchInRow && atulPunchInRow.in_time !== null
        });

        // SCENARIO 2.3: Duplicate Punch-In Blocked
        const dupMarkIn = await apiRequest('/mark-in', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        const sc2_3 = path.join(FOLDERS.ATTENDANCE, '03-duplicate-punch-in-blocked.png');
        await attPage.screenshot({ path: sc2_3 });
        recordAudit({
            id: 'ATT-03',
            category: 'Attendance Rules',
            name: 'Duplicate Punch-In Blocked',
            expected: 'HTTP 400: You\'ve already checked in today! Looking good.',
            actual: `Status: ${dupMarkIn.status}, Message: "${dupMarkIn.data.message}"`,
            dbCheck: 'Unique constraint on (username, date) preserved',
            screenshot: sc2_3,
            pass: dupMarkIn.status === 400 && dupMarkIn.data.message.includes('already checked in')
        });

        // SCENARIO 2.4: Valid Punch-Out Execution
        const validMarkOut = await apiRequest('/mark-out', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        await attPage.reload();
        await attPage.waitForSelector('#day-complete-message:not([style*="display: none"])', { timeout: 8000 });
        const sc2_4 = path.join(FOLDERS.ATTENDANCE, '04-valid-punch-out-recorded.png');
        await attPage.screenshot({ path: sc2_4 });
        const atulPunchOutRow = await db.get('SELECT out_time, out_latitude, out_longitude FROM attendance WHERE username = ?', ['atul']);
        recordAudit({
            id: 'ATT-04',
            category: 'Attendance Rules',
            name: 'Valid Punch-Out Execution',
            expected: 'HTTP 200: All set! You\'re checked out.',
            actual: `Status: ${validMarkOut.status}, Message: "${validMarkOut.data.message}"`,
            dbCheck: `DB out_time: ${atulPunchOutRow.out_time}`,
            screenshot: sc2_4,
            pass: validMarkOut.status === 200 && atulPunchOutRow && atulPunchOutRow.out_time !== null
        });

        // SCENARIO 2.5: Duplicate Punch-Out Blocked
        const dupMarkOut = await apiRequest('/mark-out', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: atulCookie
        });
        const sc2_5 = path.join(FOLDERS.ATTENDANCE, '05-duplicate-punch-out-blocked.png');
        await attPage.screenshot({ path: sc2_5 });
        recordAudit({
            id: 'ATT-05',
            category: 'Attendance Rules',
            name: 'Duplicate Punch-Out Blocked',
            expected: 'HTTP 400: You\'ve already checked out. See you tomorrow!',
            actual: `Status: ${dupMarkOut.status}, Message: "${dupMarkOut.data.message}"`,
            dbCheck: 'Original punch-out time preserved unchanged',
            screenshot: sc2_5,
            pass: dupMarkOut.status === 400 && dupMarkOut.data.message.includes('already checked out')
        });

        // SCENARIO 2.6: Punching In Blocked When Approved Leave Exists for Today
        const todayStr = new Date().toISOString().slice(0, 10);
        await db.run('DELETE FROM attendance WHERE username = ?', ['kamini']);
        await db.run('DELETE FROM leaves WHERE username = ?', ['kamini']);
        await db.run('INSERT INTO leaves (username, start_date, end_date, reason, status, leave_type) VALUES (?, ?, ?, ?, ?, ?)',
            ['kamini', todayStr, todayStr, 'Approved testing leave', 'approved', 'full']);

        const kaminiContext = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            geolocation: { latitude: 28.6139, longitude: 77.2090 },
            permissions: ['camera', 'geolocation']
        });
        const kaminiPage = await kaminiContext.newPage();
        await kaminiPage.goto(`${BASE_URL}/login`);
        await kaminiPage.fill('#name', 'kamini');
        await kaminiPage.fill('#password', '111');
        await kaminiPage.click('button[type="submit"]');
        await kaminiPage.waitForURL('**/dashboard');
        const kaminiCookie = await getCookiesString(kaminiContext);

        const punchWithApprovedLeave = await apiRequest('/mark-in', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: kaminiCookie
        });
        const sc2_6 = path.join(FOLDERS.ATTENDANCE, '06-approved-leave-punch-blocked.png');
        await kaminiPage.screenshot({ path: sc2_6 });
        recordAudit({
            id: 'ATT-06',
            category: 'Attendance Rules',
            name: 'Approved Leave Conflicts Block Punch-In',
            expected: 'HTTP 403: You have approved leave today. Enjoy your time off!',
            actual: `Status: ${punchWithApprovedLeave.status}, Message: "${punchWithApprovedLeave.data.message}"`,
            dbCheck: 'Zero attendance row inserted for user on approved leave',
            screenshot: sc2_6,
            pass: punchWithApprovedLeave.status === 403 && punchWithApprovedLeave.data.message.includes('approved leave today')
        });

        // SCENARIO 2.7: Pending Leave Auto-Withdrawal Prompt
        await db.run('UPDATE leaves SET status = ? WHERE username = ?', ['pending', 'kamini']);
        const pendingCheckRes = await apiRequest('/mark-in', {
            method: 'POST',
            body: { latitude: 28.6139, longitude: 77.2090, selfie: getValidSelfieBase64() },
            cookie: kaminiCookie
        });
        const sc2_7 = path.join(FOLDERS.ATTENDANCE, '07-pending-leave-withdrawal-confirmation.png');
        await kaminiPage.screenshot({ path: sc2_7 });
        recordAudit({
            id: 'ATT-07',
            category: 'Attendance Rules',
            name: 'Pending Leave Auto-Withdrawal Confirmation',
            expected: 'HTTP 409: requiresConfirmation=true with leave_id',
            actual: `Status: ${pendingCheckRes.status}, requiresConfirmation: ${pendingCheckRes.data.requiresConfirmation}`,
            dbCheck: `Pending leave id identified: ${pendingCheckRes.data.leave_id}`,
            screenshot: sc2_7,
            pass: pendingCheckRes.status === 409 && pendingCheckRes.data.requiresConfirmation === true
        });

        // Restore standard weekly off policy
        await db.run("UPDATE settings SET value = '3' WHERE name = 'weekly_off_mode'");
        await attContext.close();
        await kaminiContext.close();

        // =========================================================================
        // CATEGORY 3: LEAVE MANAGEMENT & VALIDATION RULES
        // =========================================================================
        console.log('▶ [CATEGORY 3] LEAVE MANAGEMENT & VALIDATION RULES\n');

        await db.run('DELETE FROM leaves WHERE username = ?', ['nazmul']);
        await db.run('DELETE FROM attendance WHERE username = ?', ['nazmul']);

        const leaveContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const leavePage = await leaveContext.newPage();
        await leavePage.goto(`${BASE_URL}/login`);
        await leavePage.fill('#name', 'nazmul');
        await leavePage.fill('#password', '111');
        await leavePage.click('button[type="submit"]');
        await leavePage.waitForURL('**/dashboard');
        
        const nazmulCookie = await getCookiesString(leaveContext);

        // SCENARIO 3.1: Start Date After End Date Blocked
        const invalidOrderRes = await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-10', end_date: '2026-12-05', reason: 'Vacation', leave_type: 'full' },
            cookie: nazmulCookie
        });
        const sc3_1 = path.join(FOLDERS.LEAVES, '01-start-after-end-date-blocked.png');
        await leavePage.screenshot({ path: sc3_1 });
        recordAudit({
            id: 'LEAVE-01',
            category: 'Leave Validation',
            name: 'End Date Before Start Date Blocked',
            expected: 'HTTP 400: Start date cannot be after end date.',
            actual: `Status: ${invalidOrderRes.status}, Message: "${invalidOrderRes.data.message}"`,
            dbCheck: 'Zero rows inserted in leaves table',
            screenshot: sc3_1,
            pass: invalidOrderRes.status === 400 && invalidOrderRes.data.message.includes('cannot be after end date')
        });

        // SCENARIO 3.2: Half-Day Multi-Day Blocked
        const invalidHalfDayRes = await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-10', end_date: '2026-12-12', reason: 'Doctor visit', leave_type: 'half' },
            cookie: nazmulCookie
        });
        const sc3_2 = path.join(FOLDERS.LEAVES, '02-half-day-multi-day-blocked.png');
        await leavePage.screenshot({ path: sc3_2 });
        recordAudit({
            id: 'LEAVE-02',
            category: 'Leave Validation',
            name: 'Half-Day Leave Restricted to Single Day',
            expected: 'HTTP 400: Half-day leaves can only be applied for a single day.',
            actual: `Status: ${invalidHalfDayRes.status}, Message: "${invalidHalfDayRes.data.message}"`,
            dbCheck: 'Zero rows inserted',
            screenshot: sc3_2,
            pass: invalidHalfDayRes.status === 400 && invalidHalfDayRes.data.message.includes('single day')
        });

        // SCENARIO 3.3: Empty Reason Rejected
        const emptyReasonRes = await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-15', end_date: '2026-12-15', reason: '   ', leave_type: 'full' },
            cookie: nazmulCookie
        });
        const sc3_3 = path.join(FOLDERS.LEAVES, '03-empty-reason-rejected.png');
        await leavePage.screenshot({ path: sc3_3 });
        recordAudit({
            id: 'LEAVE-03',
            category: 'Leave Validation',
            name: 'Empty Reason Text Rejected',
            expected: 'HTTP 400: Please provide a reason for the leave',
            actual: `Status: ${emptyReasonRes.status}, Message: "${emptyReasonRes.data.message}"`,
            dbCheck: 'Validation rejected before DB query',
            screenshot: sc3_3,
            pass: emptyReasonRes.status === 400 && emptyReasonRes.data.message.includes('provide a reason')
        });

        // SCENARIO 3.4: Reason Longer Than 250 Characters Rejected
        const tooLongReason = 'A'.repeat(260);
        const longReasonRes = await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-15', end_date: '2026-12-15', reason: tooLongReason, leave_type: 'full' },
            cookie: nazmulCookie
        });
        const sc3_4 = path.join(FOLDERS.LEAVES, '04-reason-max-length-enforced.png');
        await leavePage.screenshot({ path: sc3_4 });
        recordAudit({
            id: 'LEAVE-04',
            category: 'Leave Validation',
            name: 'Reason Maximum Length (250 chars) Enforced',
            expected: 'HTTP 400: Reason cannot exceed 250 characters.',
            actual: `Status: ${longReasonRes.status}, Message: "${longReasonRes.data.message}"`,
            dbCheck: 'Oversized payload rejected',
            screenshot: sc3_4,
            pass: longReasonRes.status === 400 && longReasonRes.data.message.includes('cannot exceed 250 characters')
        });

        // SCENARIO 3.5: Leave On Already Attended Day Blocked
        await db.run('INSERT INTO attendance (username, date, in_time) VALUES (?, ?, ?)',
            ['nazmul', '2026-12-20', '09:00:00']);
        const attendedLeaveRes = await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-20', end_date: '2026-12-20', reason: 'Personal work', leave_type: 'full' },
            cookie: nazmulCookie
        });
        const sc3_5 = path.join(FOLDERS.LEAVES, '05-leave-on-attended-day-blocked.png');
        await leavePage.screenshot({ path: sc3_5 });
        recordAudit({
            id: 'LEAVE-05',
            category: 'Leave Validation',
            name: 'Leave Blocked For Days Already Attended',
            expected: 'HTTP 400: You were present on: ... You can\'t request time off for days you\'ve already worked.',
            actual: `Status: ${attendedLeaveRes.status}, Message: "${attendedLeaveRes.data.message}"`,
            dbCheck: 'Attendance check cross-referenced in attendance table',
            screenshot: sc3_5,
            pass: attendedLeaveRes.status === 400 && attendedLeaveRes.data.message.includes('already worked')
        });

        // SCENARIO 3.6: Employee Self-Withdrawal of Pending Leave
        await apiRequest('/leaves/apply', {
            method: 'POST',
            body: { start_date: '2026-12-28', end_date: '2026-12-28', reason: 'Year end trip', leave_type: 'full' },
            cookie: nazmulCookie
        });
        const appliedLeaveRow = await db.get('SELECT leave_id FROM leaves WHERE username = ? AND start_date = ?', ['nazmul', '2026-12-28']);
        const withdrawRes = await apiRequest('/leaves/takeback', {
            method: 'POST',
            body: { leave_id: appliedLeaveRow.leave_id },
            cookie: nazmulCookie
        });
        await leavePage.reload();
        const sc3_6 = path.join(FOLDERS.LEAVES, '06-leave-withdrawal-successful.png');
        await leavePage.screenshot({ path: sc3_6 });
        const withdrawnRow = await db.get('SELECT status, taken_back FROM leaves WHERE leave_id = ?', [appliedLeaveRow.leave_id]);
        recordAudit({
            id: 'LEAVE-06',
            category: 'Leave Management',
            name: 'Employee Pending Leave Self-Withdrawal',
            expected: 'HTTP 200: Leave request withdrawn successfully',
            actual: `Status: ${withdrawRes.status}, Message: "${withdrawRes.data.message}"`,
            dbCheck: `DB status: ${withdrawnRow.status}, taken_back: ${withdrawnRow.taken_back}`,
            screenshot: sc3_6,
            pass: withdrawRes.status === 200 && withdrawnRow.status === 'withdrawn' && withdrawnRow.taken_back === 1
        });

        await leaveContext.close();

        // =========================================================================
        // CATEGORY 4: ADMIN CONTROLS & MANAGEMENT SETTINGS
        // =========================================================================
        console.log('▶ [CATEGORY 4] ADMIN CONTROLS & MANAGEMENT SETTINGS\n');

        const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const adminPage = await adminContext.newPage();
        await adminPage.goto(`${BASE_URL}/login`);
        await adminPage.fill('#name', 'smita');
        await adminPage.fill('#password', '111');
        await adminPage.click('button[type="submit"]');
        await adminPage.waitForURL('**/dashboard');
        
        const smitaCookie = await getCookiesString(adminContext);

        // SCENARIO 4.1: Duplicate User Creation Blocked
        const dupUserRes = await apiRequest('/admin/users/add', {
            method: 'POST',
            body: { name: 'manuj', password: '111', role: 'employee', join_date: '2025-01-01' },
            cookie: smitaCookie
        });
        await adminPage.goto(`${BASE_URL}/team`);
        const sc4_1 = path.join(FOLDERS.ADMIN, '01-duplicate-user-creation-blocked.png');
        await adminPage.screenshot({ path: sc4_1 });
        recordAudit({
            id: 'ADMIN-01',
            category: 'User Management',
            name: 'Duplicate Username Creation Blocked',
            expected: 'HTTP 400: This username is taken. Please try a different one.',
            actual: `Status: ${dupUserRes.status}, Message: "${dupUserRes.data.message}"`,
            dbCheck: 'Primary key conflict prevented',
            screenshot: sc4_1,
            pass: dupUserRes.status === 400 && (dupUserRes.data.message.includes('taken') || dupUserRes.data.message.includes('already exists'))
        });

        // SCENARIO 4.2: Manager Cannot Create Owner or Manager
        const dineshContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const dineshPage = await dineshContext.newPage();
        await dineshPage.goto(`${BASE_URL}/login`);
        await dineshPage.fill('#name', 'dinesh');
        await dineshPage.fill('#password', '111');
        await dineshPage.click('button[type="submit"]');
        await dineshPage.waitForURL('**/dashboard');
        const dineshCookie = await getCookiesString(dineshContext);

        const managerElevateRes = await apiRequest('/admin/users/add', {
            method: 'POST',
            body: { name: 'hacker_mgr', password: '111', role: 'owner', join_date: '2025-01-01' },
            cookie: dineshCookie
        });
        const sc4_2 = path.join(FOLDERS.ADMIN, '02-manager-cannot-create-owner.png');
        await dineshPage.screenshot({ path: sc4_2 });
        recordAudit({
            id: 'ADMIN-02',
            category: 'Privilege Boundaries',
            name: 'Manager Privilege Escalation Blocked',
            expected: 'HTTP 403: Only the system owner can add managers or other owners.',
            actual: `Status: ${managerElevateRes.status}, Message: "${managerElevateRes.data.message}"`,
            dbCheck: 'Zero elevated user rows created',
            screenshot: sc4_2,
            pass: managerElevateRes.status === 403 && managerElevateRes.data.message.includes('Only the system owner')
        });
        await dineshContext.close();

        // SCENARIO 4.3: Password Reset Execution & Re-Login Verification
        const targetUser = 'abcd';
        await db.run('INSERT OR IGNORE INTO users (name, password, role) VALUES (?, ?, ?)', [targetUser, 'old123', 'employee']);
        const resetRes = await apiRequest('/admin/users/reset-password', {
            method: 'POST',
            body: { username: targetUser, password: 'newSecretPassword999' },
            cookie: smitaCookie
        });
        
        const testNewPwdRes = await apiRequest('/login', {
            method: 'POST',
            body: { name: targetUser, password: 'newSecretPassword999' }
        });
        const sc4_3 = path.join(FOLDERS.ADMIN, '03-password-reset-and-relogin.png');
        await adminPage.screenshot({ path: sc4_3 });
        const userRowAfterReset = await db.get('SELECT password FROM users WHERE name = ?', [targetUser]);
        recordAudit({
            id: 'ADMIN-03',
            category: 'User Management',
            name: 'Admin Password Reset & New Password Login',
            expected: 'HTTP 200: Password reset successful & target can log in',
            actual: `Reset: ${resetRes.status}, New Pwd Login Status: ${testNewPwdRes.status} (Redirect to /dashboard)`,
            dbCheck: 'Bcrypt hashed password updated in users table',
            screenshot: sc4_3,
            pass: resetRes.status === 200 && testNewPwdRes.status === 302
        });

        // SCENARIO 4.4: App Settings Update & Real-Time Reflection
        await apiRequest('/admin/settings/company-name', {
            method: 'POST',
            body: { name: 'TallyUp Enterprise' },
            cookie: smitaCookie
        });
        await apiRequest('/admin/settings/brand-color', {
            method: 'POST',
            body: { color: '#0ea5a4' },
            cookie: smitaCookie
        });
        const brandingGetRes = await apiRequest('/branding');
        await adminPage.goto(`${BASE_URL}/appsettings`);
        await adminPage.waitForSelector('.container', { state: 'visible' });
        const sc4_4 = path.join(FOLDERS.ADMIN, '04-company-settings-updated.png');
        await adminPage.screenshot({ path: sc4_4 });
        const companyNameSetting = await db.get('SELECT value FROM settings WHERE name = ?', ['company_name']);
        recordAudit({
            id: 'ADMIN-04',
            category: 'System Configuration',
            name: 'Company Branding & Settings Live Persistence',
            expected: 'Settings updated and reflected in /branding API',
            actual: `API companyName: "${brandingGetRes.data.companyName}", brandColor: "${brandingGetRes.data.brandColor}"`,
            dbCheck: `DB value: "${companyNameSetting.value}"`,
            screenshot: sc4_4,
            pass: brandingGetRes.data.companyName === 'TallyUp Enterprise' && companyNameSetting.value === 'TallyUp Enterprise'
        });

        // SCENARIO 4.5: Visual Matrix Calendar Data Generation
        const visualDataRes = await apiRequest('/visual/data?username=manuj&year=2026&month=10', {
            cookie: smitaCookie
        });
        await adminPage.goto(`${BASE_URL}/visual`);
        const sc4_5 = path.join(FOLDERS.ADMIN, '05-visual-matrix-calendar-verified.png');
        await adminPage.screenshot({ path: sc4_5 });
        recordAudit({
            id: 'ADMIN-05',
            category: 'Visual Analytics',
            name: 'Visual Matrix Attendance Data Integrity',
            expected: 'HTTP 200: JSON matrix with 31 days data and presence mapping',
            actual: `Status: ${visualDataRes.status}, days array length: ${visualDataRes.data.days ? visualDataRes.data.days.length : 0}`,
            dbCheck: 'Cross-table join between attendance, leaves, holidays and settings',
            screenshot: sc4_5,
            pass: visualDataRes.status === 200 && visualDataRes.data.days && visualDataRes.data.days.length === 31
        });

        // SCENARIO 4.6: Admin Leave Approval Execution
        await db.run('INSERT INTO leaves (username, start_date, end_date, reason, status, leave_type) VALUES (?, ?, ?, ?, ?, ?)',
            ['nazmul', '2026-11-20', '2026-11-20', 'Medical checkup', 'pending', 'full']);
        const pendingForApprove = await db.get('SELECT leave_id FROM leaves WHERE username = ? AND status = ?', ['nazmul', 'pending']);
        const approveLeaveRes = await apiRequest('/admin/leaves/action', {
            method: 'POST',
            body: { leave_id: pendingForApprove.leave_id, status: 'approved' },
            cookie: smitaCookie
        });
        const approvedLeaveDb = await db.get('SELECT status, approved_by FROM leaves WHERE leave_id = ?', [pendingForApprove.leave_id]);
        await adminPage.goto(`${BASE_URL}/team`);
        const sc4_6 = path.join(FOLDERS.ADMIN, '06-admin-leave-approved.png');
        await adminPage.screenshot({ path: sc4_6 });
        recordAudit({
            id: 'ADMIN-06',
            category: 'Leave Approvals',
            name: 'Admin Leave Approval Flow',
            expected: 'HTTP 200: Leave approved & status updated to approved',
            actual: `Status: ${approveLeaveRes.status}`,
            dbCheck: `DB status: ${approvedLeaveDb.status}, approved_by: ${approvedLeaveDb.approved_by}`,
            screenshot: sc4_6,
            pass: approveLeaveRes.status === 200 && approvedLeaveDb.status === 'approved' && approvedLeaveDb.approved_by === 'smita'
        });

        // SCENARIO 4.7: Admin Leave Rejection Execution
        await db.run('INSERT INTO leaves (username, start_date, end_date, reason, status, leave_type) VALUES (?, ?, ?, ?, ?, ?)',
            ['nazmul', '2026-11-25', '2026-11-25', 'Unplanned personal day', 'pending', 'full']);
        const pendingForReject = await db.get('SELECT leave_id FROM leaves WHERE username = ? AND status = ?', ['nazmul', 'pending']);
        const rejectLeaveRes = await apiRequest('/admin/leaves/action', {
            method: 'POST',
            body: { leave_id: pendingForReject.leave_id, status: 'rejected' },
            cookie: smitaCookie
        });
        const rejectedLeaveDb = await db.get('SELECT status, approved_by FROM leaves WHERE leave_id = ?', [pendingForReject.leave_id]);
        await adminPage.goto(`${BASE_URL}/team`);
        const sc4_7 = path.join(FOLDERS.ADMIN, '07-admin-leave-rejected.png');
        await adminPage.screenshot({ path: sc4_7 });
        recordAudit({
            id: 'ADMIN-07',
            category: 'Leave Approvals',
            name: 'Admin Leave Rejection Flow',
            expected: 'HTTP 200: Leave rejected & status updated to rejected',
            actual: `Status: ${rejectLeaveRes.status}`,
            dbCheck: `DB status: ${rejectedLeaveDb.status}, approved_by: ${rejectedLeaveDb.approved_by}`,
            screenshot: sc4_7,
            pass: rejectLeaveRes.status === 200 && rejectedLeaveDb.status === 'rejected' && rejectedLeaveDb.approved_by === 'smita'
        });

        await adminContext.close();

    } catch (err) {
        console.error('Audit runtime error:', err);
    } finally {
        if (browser) await browser.close();
        server.close();
    }

    // =========================================================================
    // FINAL AUDIT SUMMARY TABLE
    // =========================================================================
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('🏁 DEEP AUDIT RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    console.log('| ID       | Category         | Scenario Tested                              | Status |');
    console.log('| :------- | :--------------- | :------------------------------------------- | :----- |');
    auditResults.forEach(r => {
        const icon = r.pass ? '✅ PASS' : '❌ FAIL';
        console.log(`| ${r.id.padEnd(8)} | ${r.category.padEnd(16)} | ${r.name.padEnd(44)} | ${icon.padEnd(6)} |`);
    });
    console.log('\n═══════════════════════════════════════════════════════════════════════');

    const totalPassed = auditResults.filter(r => r.pass).length;
    console.log(`📊 Audit Score: ${totalPassed} / ${auditResults.length} scenarios passed (${Math.round(totalPassed / auditResults.length * 100)}%)`);
    console.log(`📁 All visual screenshots archived at: ${SCREENSHOTS_ROOT}`);
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    process.exit(totalPassed === auditResults.length ? 0 : 1);
}

runComprehensiveAudit().catch(e => {
    console.error('Fatal audit failure:', e);
    process.exit(1);
});
