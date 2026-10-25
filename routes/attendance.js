const express = require( 'express' );
const router = express.Router();
const { db } = require( '../db/database' );
const { saveFile } = require( '../db/storage' );
const { getMoment } = require( '../db/timezone' );
const { requireLogin } = require( '../middleware/auth' );
const {
    getEffectiveDate,
    formatDateForDisplay,
    formatTimeForDisplay,
    computeTotalTimeForRow
} = require( '../utils/dateHelper' );
const { checkIfDateIsOff } = require( '../services/offDays' );

// Check if user has pending leave for today (used for pre-attendance confirmation)
router.get( '/attendance/pending-leave-check', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    const today = getEffectiveDate( req );

    // Only return pending FULL-DAY leaves (half-day leaves can coexist with attendance)
    db.get( 'SELECT leave_id, start_date, end_date, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ? AND leave_type = ?',
        [ user.name, 'pending', today, today, 'full' ], ( err, pendingLeave ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        if ( pendingLeave )
        {
            return res.json( {
                hasPendingLeave: true,
                leave_id: pendingLeave.leave_id,
                start_date: pendingLeave.start_date,
                end_date: pendingLeave.end_date,
                reason: pendingLeave.reason
            } );
        }
        return res.json( { hasPendingLeave: false } );
    } );
} );

// Check today's attendance status for the current user
router.get( '/attendance/status', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    if ( user && user.role === 'owner' )
    {
        return res.json( { status: 'not_applicable', message: 'Attendance is not applicable for owner/admin accounts.' } );
    }
    const today = getEffectiveDate( req );

    // First check if user has approved FULL-DAY leave for today
    return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
        [ user.name, 'approved', today, today ], ( leaveErr, approvedLeave ) =>
    {
        if ( leaveErr ) return res.status( 500 ).json( { error: leaveErr.message } );
        if ( approvedLeave && approvedLeave.leave_type === 'full' )
        {
            return res.json( { status: 'off', message: 'You have approved leave today. Enjoy your time off! 🌴' } );
        }

        // Then check if it's an off-day
        return checkIfDateIsOff( today, ( err, off ) =>
        {
            if ( err ) return res.status( 500 ).json( { error: err.message } );
            if ( off && off.off )
            {
                const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                return res.json( { status: 'off', message: msg } );
            }

            // Check attendance status
            db.get( 'SELECT * FROM attendance WHERE username = ? AND date = ?', [ user.name, today ], ( err2, row ) =>
            {
                if ( err2 ) return res.status( 500 ).json( { error: err2.message } );
                if ( !row ) return res.json( { status: 'not_marked_in' } );
                if ( row.in_time && !row.out_time ) return res.json( { status: 'marked_in' } );
                if ( row.in_time && row.out_time ) return res.json( { status: 'marked_out' } );
            } );
        } );
    } );
} );

// Mark In
router.post( '/mark-in', requireLogin, async ( req, res ) =>
{
    const { latitude, longitude, selfie, confirm_withdraw } = req.body;
    const user = req.session.user;
    const now = getMoment();
    const date = getEffectiveDate( req );
    const time = now.format( 'HH:mm:ss' );

    const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' ) || ( req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1 );

    async function executeMarkIn ( pendingLeaveId = null )
    {
        // 1. Check if user already marked in
        db.get( 'SELECT in_time FROM attendance WHERE username = ? AND date = ?', [ user.name, date ], async ( selErr, existing ) =>
        {
            if ( selErr )
            {
                console.error( selErr.message );
                if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Something went wrong. Please try checking in again.' } );
                return res.redirect( '/dashboard' );
            }
            if ( existing && existing.in_time )
            {
                if ( isXhr ) return res.status( 400 ).json( { success: false, message: 'You\'ve already checked in today! Looking good. 😊' } );
                return res.redirect( '/dashboard' );
            }

            // 2. Save selfie only after validation passes
            let selfiePath = '';
            try
            {
                const base64Data = ( selfie || '' ).replace( /^data:image\/\w+;base64,/, "" );
                const buffer = Buffer.from( base64Data, 'base64' );
                const filename = `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_in.jpg`;
                const relativePath = `selfies/${ user.name }/${ filename }`;
                selfiePath = await saveFile( buffer, relativePath );
            }
            catch ( saveErr )
            {
                console.error( 'Error saving selfie:', saveErr );
                if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not save selfie. Please try again.' } );
                return res.redirect( '/dashboard' );
            }

            // 3. Finalize insertion
            const finalizeInsert = () =>
            {
                db.run( 'INSERT INTO attendance (username, date, in_time, in_latitude, in_longitude, in_selfie_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                    [ user.name, date, time, latitude, longitude, selfiePath ], function ( err )
                {
                    if ( err )
                    {
                        console.error( err.message );
                        if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark in. Please try again.' } );
                        return res.redirect( '/dashboard' );
                    }
                    console.log( `${ user.name } marked in on ${ now.format( 'D-MMM-YY' ) } at ${ now.format( 'h:mm A' ) }` );
                    const msg = pendingLeaveId ? 'Checked in successfully! Your pending leave request has been withdrawn. ✅' : 'Checked in successfully! Have a great day! ✅';
                    if ( isXhr ) return res.json( { success: true, message: msg } );
                    res.redirect( '/dashboard' );
                } );
            };

            if ( pendingLeaveId )
            {
                const ts = new Date().toISOString();
                db.run( 'UPDATE leaves SET taken_back = 1, taken_back_at = ?, status = ? WHERE leave_id = ?',
                    [ ts, 'withdrawn', pendingLeaveId ], function ( withdrawErr )
                {
                    if ( withdrawErr )
                    {
                        console.error( 'Error withdrawing pending leave:', withdrawErr );
                        if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not withdraw pending leave. Please try again.' } );
                        return res.redirect( '/dashboard' );
                    }
                    finalizeInsert();
                } );
            }
            else
            {
                finalizeInsert();
            }
        } );
    }

    if ( user && user.role !== 'owner' )
    {
        if ( !confirm_withdraw )
        {
            return db.get( 'SELECT leave_id, start_date, end_date, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
                [ user.name, 'pending', date, date ], ( pendingErr, pendingLeave ) =>
            {
                if ( pendingErr )
                {
                    console.error( 'Error checking pending leave', pendingErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
                }
                if ( pendingLeave && pendingLeave.leave_type === 'full' )
                {
                    if ( isXhr )
                    {
                        return res.status( 409 ).json( {
                            success: false,
                            requiresConfirmation: true,
                            leave_id: pendingLeave.leave_id,
                            message: 'You have a pending leave request for today. If you mark attendance, your leave request will be automatically withdrawn.'
                        } );
                    }
                    return res.redirect( '/dashboard' );
                }

                proceedWithApprovedLeaveCheck();
            } );
        }
        else
        {
            proceedWithApprovedLeaveCheck( confirm_withdraw );
        }

        function proceedWithApprovedLeaveCheck ( pendingLeaveId = null )
        {
            return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
                [ user.name, 'approved', date, date ], ( leaveErr, approvedLeave ) =>
            {
                if ( leaveErr )
                {
                    console.error( 'Error checking approved leave', leaveErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
                }
                if ( approvedLeave && approvedLeave.leave_type === 'full' )
                {
                    if ( isXhr ) return res.status( 403 ).json( { success: false, message: 'You have approved leave today. Enjoy your time off! 🌴' } );
                    return res.redirect( '/dashboard' );
                }

                return checkIfDateIsOff( date, ( err, off ) =>
                {
                    if ( err )
                    {
                        console.error( 'Error checking off-day', err );
                        return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
                    }
                    if ( off && off.off )
                    {
                        const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                        if ( isXhr ) return res.status( 403 ).json( { success: false, message: msg } );
                        return res.redirect( '/dashboard' );
                    }
                    executeMarkIn( pendingLeaveId );
                } );
            } );
        }
        return;
    }

    executeMarkIn();
} );

// Mark Out
router.post( '/mark-out', requireLogin, async ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = getMoment();
    const date = getEffectiveDate( req );
    const time = now.format( 'HH:mm:ss' );

    const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' ) || ( req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1 );

    async function executeMarkOut ()
    {
        db.get( 'SELECT in_time, out_time FROM attendance WHERE username = ? AND date = ?', [ user.name, date ], async ( selErr, row ) =>
        {
            if ( selErr )
            {
                console.error( selErr.message );
                if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark out. Please try again.' } );
                return res.redirect( '/dashboard' );
            }
            if ( !row || !row.in_time )
            {
                if ( isXhr ) return res.status( 400 ).json( { success: false, message: 'Oops! You need to check in first before checking out.' } );
                return res.redirect( '/dashboard' );
            }
            if ( row.out_time )
            {
                if ( isXhr ) return res.status( 400 ).json( { success: false, message: 'You\'ve already checked out. See you tomorrow!' } );
                return res.redirect( '/dashboard' );
            }

            let selfiePath = '';
            try
            {
                const base64Data = ( selfie || '' ).replace( /^data:image\/\w+;base64,/, "" );
                const buffer = Buffer.from( base64Data, 'base64' );
                const filename = `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_out.jpg`;
                const relativePath = `selfies/${ user.name }/${ filename }`;
                selfiePath = await saveFile( buffer, relativePath );
            }
            catch ( saveErr )
            {
                console.error( 'Error saving selfie:', saveErr );
                if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not save selfie. Please try again.' } );
                return res.redirect( '/dashboard' );
            }

            db.run( 'UPDATE attendance SET out_time = ?, out_latitude = ?, out_longitude = ?, out_selfie_path = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ? AND date = ?',
                [ time, latitude, longitude, selfiePath, user.name, date ], function ( err )
            {
                if ( err )
                {
                    console.error( err.message );
                    if ( isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark out. Please try again.' } );
                    return res.redirect( '/dashboard' );
                }
                console.log( `${ user.name } marked out on ${ now.format( 'D-MMM-YY' ) } at ${ now.format( 'h:mm A' ) }` );
                if ( isXhr ) return res.json( { success: true, message: 'All set! You\'re checked out. See you tomorrow! 👋' } );
                res.redirect( '/dashboard' );
            } );
        } );
    }

    if ( user && user.role !== 'owner' )
    {
        return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
            [ user.name, 'approved', date, date ], ( leaveErr, approvedLeave ) =>
        {
            if ( leaveErr )
            {
                console.error( 'Error checking approved leave', leaveErr );
                return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
            }
            if ( approvedLeave && approvedLeave.leave_type === 'full' )
            {
                if ( isXhr ) return res.status( 403 ).json( { success: false, message: 'You have approved leave today. Enjoy your time off! 🌴' } );
                return res.redirect( '/dashboard' );
            }

            return checkIfDateIsOff( date, ( err, off ) =>
            {
                if ( err )
                {
                    console.error( 'Error checking off-day', err );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
                }
                if ( off && off.off )
                {
                    const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                    if ( isXhr ) return res.status( 403 ).json( { success: false, message: msg } );
                    return res.redirect( '/dashboard' );
                }
                executeMarkOut();
            } );
        } );
    }

    executeMarkOut();
} );

// User's own attendance list
router.get( '/attendance', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    db.all( 'SELECT * FROM attendance WHERE username = ? ORDER BY date DESC', [ user.name ], ( err, rows ) =>
    {
        if ( err )
        {
            console.error( err.message );
            return res.status( 500 ).json( [] );
        }
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

// User's attendance marked dates (YYYY-MM-DD)
router.get( '/attendance/dates', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    db.all( 'SELECT date FROM attendance WHERE username = ? AND in_time IS NOT NULL ORDER BY date DESC', [ user.name ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const dates = ( rows || [] ).map( r => r.date );
        res.json( dates );
    } );
} );

module.exports = router;
