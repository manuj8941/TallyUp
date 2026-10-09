const express = require( 'express' );
const router = express.Router();
const moment = require( 'moment-timezone' );
const { db } = require( '../db/database' );
const { getSetting } = require( '../db/settings' );
const { getUserByName } = require( '../db/users' );
const { requireLogin } = require( '../middleware/auth' );
const {
    formatTimeForDisplay,
    computeTotalTimeForRow
} = require( '../utils/dateHelper' );

// Visual calendar data
router.get( '/visual/data', requireLogin, async ( req, res ) =>
{
    try
    {
        const username = ( req.query.username || ( req.session.user && req.session.user.name ) || '' ).toString();
        const year = parseInt( req.query.year || ( new Date() ).getFullYear(), 10 );
        const month = parseInt( req.query.month || ( new Date() ).getMonth() + 1, 10 );

        if ( !username ) return res.status( 400 ).json( { error: 'username required' } );

        if ( !/^[A-Za-z0-9_]+$/.test( username ) ) return res.status( 400 ).json( { error: 'invalid username' } );

        const requester = req.session.user;
        if ( requester.role === 'employee' && requester.name !== username ) return res.status( 403 ).json( { error: 'Not authorized' } );

        const userRow = await getUserByName( username );
        if ( !userRow ) return res.status( 404 ).json( { error: 'User not found' } );
        if ( userRow.role === 'owner' ) return res.status( 404 ).json( { error: 'User not found' } );

        const mfirst = moment( `${ year }-${ ( '' + month ).padStart( 2, '0' ) }-01`, 'YYYY-MM-DD' );
        if ( !mfirst.isValid() ) return res.status( 400 ).json( { error: 'Invalid year/month' } );
        const daysInMonth = mfirst.daysInMonth();
        const firstDate = mfirst.format( 'YYYY-MM-DD' );
        const lastDate = mfirst.clone().endOf( 'month' ).format( 'YYYY-MM-DD' );

        const attendancePromise = new Promise( ( resolve ) =>
        {
            db.all( 'SELECT * FROM attendance WHERE username = ? AND date BETWEEN ? AND ?', [ username, firstDate, lastDate ], ( err, rows ) =>
            {
                if ( err ) return resolve( [] );
                return resolve( rows || [] );
            } );
        } );

        const leavesPromise = new Promise( ( resolve ) => db.all( `SELECT leave_id, start_date, end_date, reason, status, leave_type FROM leaves WHERE username = ? AND status = 'approved' AND NOT (end_date < ? OR start_date > ?)`, [ username, firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const adhocPromise = new Promise( ( resolve ) => db.all( 'SELECT date, reason FROM ad_hoc_offs WHERE date BETWEEN ? AND ?', [ firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const holidaysPromise = new Promise( ( resolve ) => db.all( 'SELECT id, name, month_day, date FROM holidays', [], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const weeklyModePromise = getSetting( 'weekly_off_mode' ).then( ( value ) => value || '1' ).catch( () => '1' );

        const [ attendanceRows, leaveRows, adhocRows, holidaysRows, weeklyMode ] = await Promise.all( [ attendancePromise, leavesPromise, adhocPromise, holidaysPromise, weeklyModePromise ] );

        const attendanceMap = {};
        ( attendanceRows || [] ).forEach( r => { if ( r && r.date ) attendanceMap[ r.date ] = r; } );

        const adhocMap = {};
        ( adhocRows || [] ).forEach( a => { adhocMap[ a.date ] = a.reason || ''; } );

        const holidaysByDate = {};
        const holidaysByMMDD = {};
        ( holidaysRows || [] ).forEach( h =>
        {
            if ( h.date ) holidaysByDate[ h.date ] = h.name || '';
            if ( h.month_day ) holidaysByMMDD[ h.month_day ] = h.name || '';
        } );

        const leaves = leaveRows || [];
        const days = [];

        for ( let d = 1; d <= daysInMonth; d++ )
        {
            const date = `${ year }-${ ( '' + month ).padStart( 2, '0' ) }-${ ( '' + d ).padStart( 2, '0' ) }`;

            let off = { off: false };
            if ( adhocMap[ date ] ) { off = { off: true, type: 'ad_hoc', reason: adhocMap[ date ] }; }
            else if ( holidaysByDate[ date ] ) { off = { off: true, type: 'holiday', name: holidaysByDate[ date ] }; }
            else
            {
                const mmdd = moment( date, 'YYYY-MM-DD' ).format( 'MM-DD' );
                if ( holidaysByMMDD[ mmdd ] ) { off = { off: true, type: 'holiday', name: holidaysByMMDD[ mmdd ] }; }
                else
                {
                    const m = moment( date, 'YYYY-MM-DD' );
                    const dow = m.day();
                    if ( dow === 0 ) off = { off: true, type: 'weekly', mode: weeklyMode };
                    else if ( dow === 6 )
                    {
                        const dom = m.date();
                        const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
                        if ( weeklyMode === '2' ) off = { off: true, type: 'weekly', mode: weeklyMode };
                        else if ( weeklyMode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) off = { off: true, type: 'weekly', mode: weeklyMode };
                        else if ( weeklyMode === '4' && ( weekOfMonth % 2 === 1 ) ) off = { off: true, type: 'weekly', mode: weeklyMode };
                    }
                }
            }

            const leave = leaves.find( L => L && L.start_date && L.end_date && ( L.start_date <= date && L.end_date >= date ) ) || null;
            const att = attendanceMap[ date ] || null;

            let status = 'absent';
            let holiday_name = '';
            let adhoc_reason = '';
            if ( off && off.off )
            {
                if ( off.type === 'ad_hoc' ) { status = 'ad_hoc'; adhoc_reason = off.reason || ''; }
                else if ( off.type === 'holiday' ) { status = 'holiday'; holiday_name = off.name || ''; }
                else if ( off.type === 'weekly' ) { status = 'weekly'; }
            }

            if ( !off.off )
            {
                if ( leave && leave.leave_type === 'half' && att && att.in_time )
                {
                    status = 'half_day_leave';
                }
                else if ( leave && leave.leave_type === 'full' )
                {
                    status = 'leave';
                }
                else if ( leave && leave.leave_type === 'half' && ( !att || !att.in_time ) )
                {
                    status = 'absent_half_leave';
                }
                else if ( att && att.in_time )
                {
                    status = 'present';
                }
            }

            days.push( {
                date,
                status,
                in_time: att && att.in_time ? formatTimeForDisplay( date, att.in_time ) : null,
                out_time: att && att.out_time ? formatTimeForDisplay( date, att.out_time ) : null,
                total_time: att ? computeTotalTimeForRow( att ) : null,
                holiday_name: holiday_name || null,
                adhoc_reason: adhoc_reason || null,
                leave: leave ? { leave_id: leave.leave_id, status: leave.status, reason: leave.reason, leave_type: leave.leave_type || 'full' } : null
            } );
        }

        return res.json( { year, month, days } );
    }
    catch ( e )
    {
        console.error( 'Error building visual data JSON:', e );
        return res.status( 500 ).json( { error: 'Server error' } );
    }
} );

module.exports = router;
