const express = require( 'express' );
const router = express.Router();
const path = require( 'path' );
const fs = require( 'fs' );
const moment = require( 'moment-timezone' );
const { db } = require( '../db/database' );
const { useTurso } = require( '../db/connection' );
const { saveFile, deleteFile } = require( '../db/storage' );
const { getSettings, updateSetting, getSetting, updateTimezone } = require( '../db/settings' );
const { getMoment } = require( '../db/timezone' );
const { requireAdmin, requireOwner } = require( '../middleware/auth' );
const {
    getAllUsers,
    getUserByName,
    normalizeUsername,
    capitalizeUsername,
    createUser,
    getUserRole,
    updatePassword,
    deductLeaveBalance
} = require( '../db/users' );
const {
    formatDateForDisplay,
    formatTimeForDisplay,
    computeTotalTimeForRow
} = require( '../utils/dateHelper' );

const selfiesDir = path.join( __dirname, '..', 'selfies' );

// Get all users
router.get( '/admin/users', requireAdmin, async ( req, res ) =>
{
    try
    {
        const users = await getAllUsers();
        res.json( users );
    }
    catch ( err )
    {
        res.status( 500 ).json( { error: err.message } );
    }
} );

// Add new user
router.post( '/admin/users/add', requireAdmin, async ( req, res ) =>
{
    const { name, password, role, join_date } = req.body;
    const rawUsername = ( name || '' ).trim();
    const pwd = ( password && password.trim() ) ? password.trim() : '111';
    const userRole = role || 'employee';

    if ( !/^[A-Za-z.\-_\s]+$/.test( rawUsername ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please use only letters (spaces, dots, and hyphens are allowed).' } );
    }

    try
    {
        const username = normalizeUsername( rawUsername );

        const existingUser = await getUserByName( username );
        if ( existingUser ) return res.status( 400 ).json( { success: false, message: 'This username is taken. Please try a different one.' } );

        const joinDate = ( join_date && join_date.trim() ) ? join_date.trim() : getMoment().format( 'YYYY-MM-DD' );
        if ( req.session.user && req.session.user.role === 'manager' && ( userRole === 'owner' || userRole === 'manager' ) )
        {
            return res.status( 403 ).json( { success: false, message: 'Only the system owner can add managers or other owners.' } );
        }

        await createUser( username, pwd, userRole, joinDate );

        try
        {
            const userSelfieDir = path.join( selfiesDir, username );
            if ( !fs.existsSync( userSelfieDir ) ) fs.mkdirSync( userSelfieDir, { recursive: true } );
        }
        catch ( fsErr )
        {
            console.error( 'Error creating selfie dir for', username, fsErr.message );
        }

        console.log( `Admin ${ req.session.user.name } added user ${ username } with role ${ userRole }` );
        res.json( { success: true, message: 'The team member has been added and can now log in. 🎉' } );
    }
    catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error creating user.' } );
    }
} );

// Reset user password
router.post( '/admin/users/reset-password', requireAdmin, async ( req, res ) =>
{
    const { username, password } = req.body;
    const newPwd = ( password && password.trim() ) ? password.trim() : '111';
    const requesterRole = req.session.user && req.session.user.role;

    if ( !username || !username.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'Please select a team member to reset.' } );
    }

    try
    {
        const target = username.trim();
        const targetRole = await getUserRole( target );
        if ( !targetRole ) return res.status( 404 ).json( { success: false, message: 'We couldn\'t find that team member.' } );

        if ( requesterRole === 'owner' )
        {
            // Allowed
        }
        else if ( requesterRole === 'manager' )
        {
            if ( targetRole !== 'employee' ) return res.status( 403 ).json( { success: false, message: 'You can only reset passwords for team members (not managers or owners).' } );
        }
        else
        {
            return res.status( 403 ).json( { success: false, message: 'You\'re not authorized to do this.' } );
        }

        await updatePassword( target, newPwd );
        return res.json( { success: true, message: `Password reset for ${ target }. Their new password is: ${ newPwd }` } );
    }
    catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error resetting password.' } );
    }
} );

// View employee attendance
router.get( '/admin/attendance/:username', requireAdmin, ( req, res ) =>
{
    const { username } = req.params;
    db.all( 'SELECT * FROM attendance WHERE username = ? ORDER BY date DESC', [ username ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row => ( {
            ...row,
            date: formatDateForDisplay( row.date ),
            in_time: formatTimeForDisplay( row.date, row.in_time ),
            out_time: formatTimeForDisplay( row.date, row.out_time ),
            total_time: computeTotalTimeForRow( row )
        } ) );
        res.json( formattedRows );
    } );
} );

// View pending leaves
router.get( '/admin/leaves', requireAdmin, ( req, res ) =>
{
    const user = req.session.user;
    const query = "SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.status = 'pending' ORDER BY l.start_date ASC";

    db.all( query, [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );

        let filteredRows = rows;
        if ( user.role === 'manager' )
        {
            filteredRows = rows.filter( row => row.role === 'employee' );
        }

        const formattedRows = filteredRows.map( row =>
        {
            const fullReason = row.reason || '';
            const truncated = fullReason.length > 25 ? fullReason.substring( 0, 25 ) + '...' : fullReason;
            return {
                ...row,
                start_date: formatDateForDisplay( row.start_date ),
                end_date: formatDateForDisplay( row.end_date ),
                reason_truncated: truncated,
                reason_full: fullReason,
                is_backdated: row.is_backdated ? !!row.is_backdated : false,
                taken_back: row.taken_back ? !!row.taken_back : false,
                taken_back_at: row.taken_back_at || ''
            };
        } );

        res.json( formattedRows );
    } );
} );

// View all leave history
router.get( '/admin/leaves/history', requireAdmin, ( req, res ) =>
{
    db.all( "SELECT * FROM leaves ORDER BY start_date DESC", [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row =>
        {
            const fullReason = row.reason || '';
            const truncated = fullReason.length > 25 ? fullReason.substring( 0, 25 ) + '...' : fullReason;
            return {
                ...row,
                start_date: formatDateForDisplay( row.start_date ),
                end_date: formatDateForDisplay( row.end_date ),
                reason_truncated: truncated,
                reason_full: fullReason,
                is_backdated: row.is_backdated ? !!row.is_backdated : false,
                taken_back: row.taken_back ? !!row.taken_back : false,
                taken_back_at: row.taken_back_at || ''
            };
        } );
        res.json( formattedRows );
    } );
} );

// Approve or reject leave
router.post( '/admin/leaves/action', requireAdmin, async ( req, res ) =>
{
    const { leave_id, status } = req.body;
    const admin = req.session.user;

    try
    {
        const leave = await new Promise( ( resolve, reject ) =>
        {
            db.get( 'SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.leave_id = ?', [ leave_id ], ( err, row ) =>
            {
                if ( err ) return reject( err );
                resolve( row );
            } );
        } );

        if ( !leave ) return res.status( 404 ).send( 'Leave request not found.' );

        if ( leave.taken_back )
        {
            return res.status( 400 ).send( 'This request was withdrawn by the team member.' );
        }

        if ( leave.status !== 'pending' )
        {
            return res.status( 409 ).send( 'This request was already processed. Please refresh the page to see the latest status.' );
        }

        if ( admin.role === 'manager' && leave.role !== 'employee' )
        {
            return res.status( 403 ).send( 'You can only approve or decline requests from team members (not managers or owners).' );
        }

        if ( admin.role !== 'owner' && leave.role === 'manager' )
        {
            return res.status( 403 ).send( 'Only the system owner can approve or decline manager requests.' );
        }

        if ( status === 'approved' )
        {
            const leaveDuration = moment( leave.end_date ).diff( moment( leave.start_date ), 'days' ) + 1;
            const leaveDays = leave.leave_type === 'half' ? 0.5 : leaveDuration;
            await deductLeaveBalance( leave.username, leaveDays );
        }

        await new Promise( ( resolve, reject ) =>
        {
            db.run( 'UPDATE leaves SET status = ?, approved_by = ? WHERE leave_id = ?', [ status, admin.name, leave_id ], function ( err )
            {
                if ( err ) return reject( err );
                resolve();
            } );
        } );

        console.log( `${ admin.name } ${ status } leave for ${ leave.username } from dates ${ formatDateForDisplay( leave.start_date ) } to ${ formatDateForDisplay( leave.end_date ) }` );
        res.sendStatus( 200 );
    }
    catch ( err )
    {
        return res.status( 500 ).send( 'Something went wrong. Please try processing this request again.' );
    }
} );

// App settings
router.get( '/admin/settings/app', requireOwner, async ( req, res ) =>
{
    try
    {
        const settings = await getSettings( [ 'desktop_enabled', 'weekly_off_mode', 'timezone' ] );
        const desktop_enabled = settings.desktop_enabled === '1';
        const weekly_off_mode = settings.weekly_off_mode || '1';
        const timezone = settings.timezone || 'Asia/Kolkata';

        const adhocPromise = new Promise( ( resolve, reject ) => db.all( 'SELECT id, date, reason, created_by, created_at FROM ad_hoc_offs ORDER BY date ASC', [], ( err, rows ) => err ? reject( err ) : resolve( rows || [] ) ) );
        const holidaysPromise = new Promise( ( resolve, reject ) => db.all( 'SELECT id, name, month_day, date FROM holidays ORDER BY month_day ASC, date ASC', [], ( err, rows ) => err ? reject( err ) : resolve( rows || [] ) ) );

        const [ adhocs, hols ] = await Promise.all( [ adhocPromise, holidaysPromise ] );

        return res.json( { desktop_enabled, weekly_off_mode, timezone, ad_hoc_offs: adhocs, holidays: hols } );
    }
    catch ( error )
    {
        return res.status( 500 ).json( { error: error.message } );
    }
} );

// Update app settings
router.post( '/admin/settings/app', requireOwner, async ( req, res ) =>
{
    try
    {
        const { desktop_enabled, weekly_off_mode } = req.body || {};
        const allowed = [ '1', '2', '3' ];
        const mode = ( '' + ( weekly_off_mode || '1' ) ).trim();
        if ( allowed.indexOf( mode ) === -1 ) return res.status( 400 ).json( { success: false, message: 'Please choose a valid weekly off mode (1, 2, or 3).' } );

        const enabled = ( desktop_enabled === true || desktop_enabled === '1' || desktop_enabled === 1 ) ? '1' : '0';

        await updateSetting( 'desktop_enabled', enabled );
        await updateSetting( 'weekly_off_mode', mode );

        return res.json( { success: true, message: 'Settings saved! All updated. ✅' } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message } );
    }
} );

// Test date override
router.get( '/admin/settings/test-date', requireOwner, ( req, res ) =>
{
    const val = req.app.locals.testDateOverride || '';
    return res.json( { test_date: val || null } );
} );

router.post( '/admin/settings/test-date', requireOwner, async ( req, res ) =>
{
    try
    {
        const { test_date } = req.body || {};
        if ( test_date && !moment( test_date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'Please use YYYY-MM-DD format (like 2025-12-25).' } );
        const value = test_date ? test_date : '';

        await updateSetting( 'test_date_override', value );
        req.app.locals.testDateOverride = value;

        return res.json( { success: true, test_date: value || null } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message } );
    }
} );

// Timezone
router.post( '/admin/settings/timezone', requireOwner, async ( req, res ) =>
{
    try
    {
        const { timezone } = req.body || {};
        if ( !timezone ) return res.status( 400 ).json( { success: false, message: 'Timezone is required.' } );

        await updateTimezone( timezone );
        return res.json( { success: true, message: 'Timezone updated successfully!' } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message || 'Invalid timezone' } );
    }
} );

// Ad-hoc off add
router.post( '/admin/settings/app/ad-hoc/add', requireOwner, ( req, res ) =>
{
    const { date, reason } = req.body || {};
    if ( !date ) return res.status( 400 ).json( { success: false, message: 'Date is required.' } );
    const m = moment( date, 'YYYY-MM-DD', true );
    if ( !m.isValid() ) return res.status( 400 ).json( { success: false, message: 'Date must be in YYYY-MM-DD format.' } );
    if ( !m.isAfter( getMoment(), 'day' ) ) return res.status( 400 ).json( { success: false, message: 'Ad-hoc off must be declared at least one day before.' } );

    getSetting( 'weekly_off_mode' ).then( ( value ) =>
    {
        const mode = value || '1';
        const dow = m.day();

        let isWeeklyOff = false;
        if ( dow === 0 ) isWeeklyOff = true;
        else if ( dow === 6 )
        {
            const dom = m.date();
            const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
            if ( mode === '2' ) isWeeklyOff = true;
            else if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) isWeeklyOff = true;
            else if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) isWeeklyOff = true;
        }

        if ( isWeeklyOff )
        {
            return res.status( 400 ).json( { success: false, message: 'This date is already a weekly off. No need to add it as a special day off.' } );
        }

        const r = ( reason || '' ).toString().substring( 0, 250 );
        const ts = new Date().toISOString();
        db.run( 'INSERT OR REPLACE INTO ad_hoc_offs (date, reason, created_by, created_at) VALUES (?, ?, ?, ?)', [ date, r, req.session.user.name, ts ], function ( err )
        {
            if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
            return res.json( { success: true } );
        } );
    } ).catch( ( err ) => res.status( 500 ).json( { success: false, message: err.message } ) );
} );

// Ad-hoc off remove
router.post( '/admin/settings/app/ad-hoc/remove', requireOwner, ( req, res ) =>
{
    const { id } = req.body || {};
    if ( !id ) return res.status( 400 ).json( { success: false, message: 'id is required.' } );
    db.get( 'SELECT date, reason FROM ad_hoc_offs WHERE id = ?', [ id ], ( getErr, row ) =>
    {
        if ( getErr ) return res.status( 500 ).json( { success: false, message: getErr.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Ad-hoc off not found.' } );
        db.run( 'DELETE FROM ad_hoc_offs WHERE id = ?', [ id ], function ( delErr )
        {
            if ( delErr ) return res.status( 500 ).json( { success: false, message: delErr.message } );
            return res.json( { success: true } );
        } );
    } );
} );

// Holidays add
router.post( '/admin/settings/app/holidays/add', requireOwner, ( req, res ) =>
{
    const { name, month_day, date } = req.body || {};
    if ( !name ) return res.status( 400 ).json( { success: false, message: 'name is required.' } );

    let insertMonthDay = null;
    let insertDate = null;
    let checkDate = null;

    if ( date )
    {
        if ( !moment( date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'date must be YYYY-MM-DD.' } );
        insertDate = date;
        checkDate = moment( date, 'YYYY-MM-DD' );
    }
    else if ( month_day )
    {
        if ( !/^[0-1][0-9]-[0-3][0-9]$/.test( month_day ) ) return res.status( 400 ).json( { success: false, message: 'month_day must be MM-DD.' } );
        insertMonthDay = month_day;
        checkDate = moment( `${ getMoment().year() }-${ month_day }`, 'YYYY-MM-DD' );
    }
    else
    {
        return res.status( 400 ).json( { success: false, message: 'Provide either `date` (YYYY-MM-DD) or `month_day` (MM-DD).' } );
    }

    getSetting( 'weekly_off_mode' ).then( ( value ) =>
    {
        const mode = value || '1';
        const dow = checkDate.day();

        let isWeeklyOff = false;
        if ( dow === 0 ) isWeeklyOff = true;
        else if ( dow === 6 )
        {
            const dom = checkDate.date();
            const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
            if ( mode === '2' ) isWeeklyOff = true;
            else if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) isWeeklyOff = true;
            else if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) isWeeklyOff = true;
        }

        if ( isWeeklyOff )
        {
            return res.status( 400 ).json( { success: false, message: 'This date falls on a weekly off. No need to add it as a holiday.' } );
        }

        db.run( 'INSERT INTO holidays (name, month_day, date) VALUES (?, ?, ?)', [ name.toString().substring( 0, 100 ), insertMonthDay, insertDate ], function ( err )
        {
            if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
            return res.json( { success: true } );
        } );
    } ).catch( ( err ) => res.status( 500 ).json( { success: false, message: err.message } ) );
} );

// Holidays remove
router.post( '/admin/settings/app/holidays/remove', requireOwner, ( req, res ) =>
{
    const { id } = req.body || {};
    if ( !id ) return res.status( 400 ).json( { success: false, message: 'id is required.' } );
    db.get( 'SELECT name, month_day, date FROM holidays WHERE id = ?', [ id ], ( getErr, row ) =>
    {
        if ( getErr ) return res.status( 500 ).json( { success: false, message: getErr.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Holiday not found.' } );
        db.run( 'DELETE FROM holidays WHERE id = ?', [ id ], function ( delErr )
        {
            if ( delErr ) return res.status( 500 ).json( { success: false, message: delErr.message } );
            return res.json( { success: true } );
        } );
    } );
} );

// Upload logo
router.post( '/admin/settings/logo', requireOwner, async ( req, res ) =>
{
    const { logo } = req.body;

    if ( !logo || !logo.startsWith( 'data:image' ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please provide a valid image.' } );
    }

    try
    {
        const matches = logo.match( /^data:image\/(\w+);base64,(.+)$/ );
        if ( !matches )
        {
            return res.status( 400 ).json( { success: false, message: 'Invalid image format.' } );
        }

        const base64Data = matches[ 2 ];
        const buffer = Buffer.from( base64Data, 'base64' );

        const sizeKB = buffer.length / 1024;
        if ( sizeKB > 5120 )
        {
            return res.status( 400 ).json( {
                success: false,
                message: `Image is too large (${ Math.round( sizeKB / 1024 ) }MB). Please upload an image smaller than 5MB.`
            } );
        }

        const timestamp = Date.now();
        const filename = `company-logo-${ timestamp }.png`;
        const relativePath = `logos/${ filename }`;
        const logoPath = await saveFile( buffer, relativePath );

        const oldLogoPath = await getSetting( 'company_logo' );
        if ( oldLogoPath && oldLogoPath.includes( '/logos/' ) )
        {
            try
            {
                await deleteFile( oldLogoPath.replace( '/r2-proxy/', '' ) );
            }
            catch ( e ) { /* ignore */ }
        }

        await updateSetting( 'company_logo', logoPath );

        res.json( {
            success: true,
            message: `Logo uploaded successfully! (${ Math.round( sizeKB ) }KB)`,
            logoPath
        } );
    }
    catch ( error )
    {
        console.error( 'Logo upload error:', error );
        res.status( 500 ).json( { success: false, message: 'Failed to process logo upload. Please try a different image.' } );
    }
} );

// Remove logo
router.post( '/admin/settings/logo/remove', requireOwner, async ( req, res ) =>
{
    try
    {
        const logoValue = await getSetting( 'company_logo' );
        if ( !logoValue )
        {
            return res.json( { success: true, message: 'No logo to remove.' } );
        }

        if ( logoValue.includes( '/logos/' ) )
        {
            try
            {
                await deleteFile( logoValue.replace( '/r2-proxy/', '' ) );
            }
            catch ( e ) { /* ignore */ }
        }

        await updateSetting( 'company_logo', '' );
        res.json( { success: true, message: 'Logo removed successfully!' } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to remove logo.' } );
    }
} );

// Brand Color
router.post( '/admin/settings/brand-color', requireOwner, async ( req, res ) =>
{
    const { color } = req.body;
    if ( !color || !/^#[0-9A-Fa-f]{6}$/.test( color ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please provide a valid hex color (e.g., #0ea5a4).' } );
    }

    try
    {
        await updateSetting( 'brand_color', color );
        res.json( { success: true, message: 'Brand color updated successfully!' } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to update brand color.' } );
    }
} );

// Company Name
router.post( '/admin/settings/company-name', requireOwner, async ( req, res ) =>
{
    try
    {
        const { name } = req.body;
        const companyName = ( name || '' ).trim();
        if ( !companyName )
        {
            return res.status( 400 ).json( { success: false, message: 'Please provide a company name.' } );
        }

        await updateSetting( 'company_name', companyName );
        res.json( { success: true, message: 'Company name updated successfully!' } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to update company name.' } );
    }
} );

// Reset brand color
router.post( '/admin/settings/brand-color/reset', requireOwner, async ( req, res ) =>
{
    try
    {
        const defaultColor = '#0ea5a4';
        await updateSetting( 'brand_color', defaultColor );
        res.json( { success: true, message: 'Brand color reset to default!', color: defaultColor } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to reset brand color.' } );
    }
} );

// Reset company name
router.post( '/admin/settings/company-name/reset', requireOwner, async ( req, res ) =>
{
    try
    {
        const defaultName = 'Attendance System';
        await updateSetting( 'company_name', defaultName );
        res.json( { success: true, message: 'Company name reset to default!', name: defaultName } );
    }
    catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to reset company name.' } );
    }
} );

// Backup download
router.get( '/admin/backup/download', requireOwner, async ( req, res ) =>
{
    try
    {
        const customFilename = ( req.query.filename || 'attendance-backup.db' ).replace( /[^a-zA-Z0-9_\-\.]/g, '_' );

        if ( useTurso )
        {
            const sqlite3 = require( 'sqlite3' ).verbose();
            const os = require( 'os' );
            const backupPath = path.join( os.tmpdir(), `attendance-backup-${ Date.now() }.db` );
            const backupDb = new sqlite3.Database( backupPath );

            const tables = await db.all( "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" );

            for ( const table of tables )
            {
                const tableName = table.name;
                const schemaResult = await db.all( `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [ tableName ] );
                if ( schemaResult.length > 0 && schemaResult[ 0 ].sql )
                {
                    await new Promise( ( resolve, reject ) =>
                    {
                        backupDb.run( schemaResult[ 0 ].sql, ( err ) => err ? reject( err ) : resolve() );
                    } );

                    const rows = await db.all( `SELECT * FROM ${ tableName }` );
                    if ( rows.length > 0 )
                    {
                        const columns = Object.keys( rows[ 0 ] );
                        const placeholders = columns.map( () => '?' ).join( ', ' );
                        const insertSql = `INSERT INTO ${ tableName } (${ columns.join( ', ' ) }) VALUES (${ placeholders })`;

                        for ( const row of rows )
                        {
                            const values = columns.map( col => row[ col ] );
                            await new Promise( ( resolve, reject ) =>
                            {
                                backupDb.run( insertSql, values, ( err ) => err ? reject( err ) : resolve() );
                            } );
                        }
                    }
                }
            }

            await new Promise( ( resolve, reject ) =>
            {
                backupDb.close( ( err ) => err ? reject( err ) : resolve() );
            } );

            const fileBuffer = fs.readFileSync( backupPath );
            fs.unlinkSync( backupPath );

            res.setHeader( 'Content-Type', 'application/octet-stream' );
            res.setHeader( 'Content-Disposition', `attachment; filename="${ customFilename }"` );
            res.setHeader( 'Content-Length', fileBuffer.length );
            res.send( fileBuffer );
        }
        else
        {
            const dbPath = path.join( __dirname, '..', 'attendance.db' );
            if ( !fs.existsSync( dbPath ) )
            {
                return res.status( 404 ).json( { success: false, message: 'Database file not found.' } );
            }

            const fileBuffer = fs.readFileSync( dbPath );
            res.setHeader( 'Content-Type', 'application/octet-stream' );
            res.setHeader( 'Content-Disposition', `attachment; filename="${ customFilename }"` );
            res.setHeader( 'Content-Length', fileBuffer.length );
            res.send( fileBuffer );
        }
    }
    catch ( err )
    {
        console.error( 'Backup download error:', err );
        return res.status( 500 ).json( { success: false, message: 'Failed to download backup.' } );
    }
} );

module.exports = router;
