const express = require( 'express' );
const router = express.Router();
const moment = require( 'moment-timezone' );
const { db } = require( '../db/database' );
const { requireLogin } = require( '../middleware/auth' );
const { getEffectiveDate, formatDateForDisplay } = require( '../utils/dateHelper' );
const { checkRangeForOffDates } = require( '../services/offDays' );
const { calculateAndUpdateLeaveBalance } = require( '../services/leaveAccrual' );

// Get leave balance
router.get( '/leaves/balance', requireLogin, async ( req, res ) =>
{
    try
    {
        const balance = await calculateAndUpdateLeaveBalance( req.session.user.name );
        res.json( { balance } );
    }
    catch ( error )
    {
        res.status( 500 ).json( { error: error.message } );
    }
} );

// Get raw leaves (ISO dates)
router.get( '/leaves/raw', requireLogin, ( req, res ) =>
{
    const username = req.session.user.name;
    db.all( 'SELECT leave_id, start_date, end_date, status FROM leaves WHERE username = ? ORDER BY start_date DESC', [ username ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        res.json( rows || [] );
    } );
} );

// Apply for leave
router.post( '/leaves/apply', requireLogin, async ( req, res ) =>
{
    const { start_date, end_date, reason, leave_type } = req.body;
    const username = req.session.user.name;

    try
    {
        const leaveType = leave_type === 'half' ? 'half' : 'full';

        if ( !start_date || !end_date ) return res.status( 400 ).json( { success: false, message: 'Start date and end date are required.' } );
        const start = moment( start_date, 'YYYY-MM-DD', true );
        const end = moment( end_date, 'YYYY-MM-DD', true );
        if ( !start.isValid() || !end.isValid() ) return res.status( 400 ).json( { success: false, message: 'Dates must be in YYYY-MM-DD format.' } );
        if ( start.isAfter( end ) ) return res.status( 400 ).json( { success: false, message: 'Start date cannot be after end date.' } );

        if ( leaveType === 'half' && !start.isSame( end, 'day' ) )
        {
            return res.status( 400 ).json( { success: false, message: 'Half-day leaves can only be applied for a single day.' } );
        }

        const leaveDuration = end.diff( start, 'days' ) + 1;
        const leaveDays = leaveType === 'half' ? 0.5 : leaveDuration;

        const reasonText = ( reason || '' ).toString().trim();
        if ( !reasonText )
        {
            return res.status( 400 ).json( { success: false, message: 'Please provide a reason for the leave (max 250 characters).' } );
        }
        if ( reasonText.length > 250 )
        {
            return res.status( 400 ).json( { success: false, message: 'Reason cannot exceed 250 characters.' } );
        }
        const storedReason = reasonText.substring( 0, 250 );

        if ( leaveType === 'full' )
        {
            db.all( 'SELECT date FROM attendance WHERE username = ? AND date BETWEEN ? AND ? AND in_time IS NOT NULL', [ username, start_date, end_date ], async ( attErr, attRows ) =>
            {
                if ( attErr )
                {
                    console.error( 'Error checking attendance for leave apply', attErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify attendance. Please try again.' } );
                }
                if ( attRows && attRows.length > 0 )
                {
                    const dates = attRows.map( r => formatDateForDisplay( r.date ) ).join( ', ' );
                    return res.status( 400 ).json( { success: false, message: `You were present on: ${ dates }. You can't request time off for days you've already worked.` } );
                }
                return continueLeaveValidation();
            } );
        }
        else
        {
            return continueLeaveValidation();
        }

        async function continueLeaveValidation ()
        {
            const offDates = await checkRangeForOffDates( start_date, end_date );
            if ( offDates && offDates.length > 0 )
            {
                const pretty = offDates.map( o =>
                {
                    const suffix = ( o.info && o.info.type === 'ad_hoc' ) ? ` (Ad-hoc: ${ ( o.info.reason || '' ) })` : ( o.info && o.info.type === 'holiday' ? ` (Holiday: ${ ( o.info.name || '' ) })` : ( o.info && o.info.type === 'weekly' ? ' (Weekly off)' : '' ) );
                    return `${ formatDateForDisplay( o.date ) }${ suffix }`;
                } ).join( ', ' );
                return res.status( 400 ).json( { success: false, message: `Cannot apply for leave on off-day(s): ${ pretty }` } );
            }

            db.get( `SELECT 1 FROM leaves WHERE username = ? AND taken_back = 0 AND status IN ('pending','approved') AND NOT (end_date < ? OR start_date > ?) LIMIT 1`, [ username, start_date, end_date ], async ( ovErr, overlap ) =>
            {
                if ( ovErr )
                {
                    console.error( 'Error checking leave overlap', ovErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify existing leaves. Please try again.' } );
                }
                if ( overlap )
                {
                    return res.status( 400 ).json( { success: false, message: 'You already have a request for these dates.' } );
                }

                try
                {
                    const balance = await calculateAndUpdateLeaveBalance( username );
                    if ( balance < leaveDays )
                    {
                        return res.status( 400 ).json( { success: false, message: `You don't have enough days available. Current balance: ${ balance } days.` } );
                    }
                }
                catch ( balErr )
                {
                    console.error( 'Error checking balance', balErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave balance. Please try again.' } );
                }

                const today = getEffectiveDate( req );
                const isBackdated = start_date < today ? 1 : 0;

                db.run( 'INSERT INTO leaves (username, start_date, end_date, reason, is_backdated, leave_type) VALUES (?, ?, ?, ?, ?, ?)',
                    [ username, start_date, end_date, storedReason, isBackdated, leaveType ], function ( insErr )
                {
                    if ( insErr )
                    {
                        console.error( 'Error inserting leave', insErr );
                        return res.status( 500 ).json( { success: false, message: 'We could not submit your leave request. Please try again later.' } );
                    }
                    const leaveTypeText = leaveType === 'half' ? 'half-day' : 'full-day';
                    console.log( `${ username } applied for ${ leaveTypeText } leave from ${ formatDateForDisplay( start_date ) } to ${ formatDateForDisplay( end_date ) }` );
                    return res.status( 200 ).json( { success: true, message: 'Request submitted! We\'ll let you know once it\'s reviewed. ✅' } );
                } );
            } );
        }
    }
    catch ( error )
    {
        res.status( 500 ).json( { success: false, message: error.message } );
    }
} );

// Withdraw / Take back leave
router.post( '/leaves/takeback', requireLogin, ( req, res ) =>
{
    const { leave_id } = req.body;
    const username = req.session.user.name;
    if ( !leave_id ) return res.status( 400 ).json( { success: false, message: 'leave_id is required.' } );

    db.get( 'SELECT * FROM leaves WHERE leave_id = ? AND username = ?', [ leave_id, username ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Leave request not found.' } );
        if ( row.taken_back ) return res.status( 400 ).json( { success: false, message: 'This request was already withdrawn.' } );
        if ( row.status !== 'pending' ) return res.status( 400 ).json( { success: false, message: 'You can only withdraw pending requests.' } );

        const ts = new Date().toISOString();
        db.run( 'UPDATE leaves SET taken_back = 1, taken_back_at = ?, status = ? WHERE leave_id = ?', [ ts, 'withdrawn', leave_id ], function ( upErr )
        {
            if ( upErr ) return res.status( 500 ).json( { success: false, message: 'Could not withdraw leave request.' } );
            console.log( `${ username } withdrew leave request ${ leave_id } at ${ moment( ts ).format( 'D-MMM-YY, h:mm A' ) }` );
            return res.json( { success: true, message: 'Request withdrawn successfully.' } );
        } );
    } );
} );

// List user's leaves
router.get( '/leaves', requireLogin, ( req, res ) =>
{
    db.all( 'SELECT * FROM leaves WHERE username = ? ORDER BY start_date DESC', [ req.session.user.name ], ( err, rows ) =>
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

module.exports = router;
