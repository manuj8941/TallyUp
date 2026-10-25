const moment = require( 'moment-timezone' );
const { db } = require( '../db/database' );
const { getSetting } = require( '../db/settings' );

/**
 * Check whether a given ISO date (YYYY-MM-DD) is an off day (ad-hoc, holiday, or weekly off)
 * @param {string} date - YYYY-MM-DD
 * @param {Function} callback - (err, result)
 */
function checkIfDateIsOff ( date, callback )
{
    if ( !date ) return callback( null, { off: false } );
    const m = moment( date, 'YYYY-MM-DD', true );
    if ( !m.isValid() ) return callback( null, { off: false } );

    const mmdd = m.format( 'MM-DD' );

    // 1) Check ad-hoc offs
    db.get( 'SELECT id, reason FROM ad_hoc_offs WHERE date = ?', [ date ], ( err, adhoc ) =>
    {
        if ( err ) return callback( err );
        if ( adhoc ) return callback( null, { off: true, type: 'ad_hoc', reason: adhoc.reason, id: adhoc.id } );

        // 2) Check holidays: first check one-off full-date holidays
        db.get( 'SELECT id, name FROM holidays WHERE date = ?', [ date ], ( errDate, holDate ) =>
        {
            if ( errDate ) return callback( errDate );
            if ( holDate ) return callback( null, { off: true, type: 'holiday', name: holDate.name } );

            // 3) Check recurring holidays (month-day)
            db.get( 'SELECT id, name FROM holidays WHERE month_day = ?', [ mmdd ], ( err2, hol ) =>
            {
                if ( err2 ) return callback( err2 );
                if ( hol ) return callback( null, { off: true, type: 'holiday', name: hol.name } );

                // 4) Check weekly off mode
                getSetting( 'weekly_off_mode' ).then( ( value ) =>
                {
                    const mode = value || '1';
                    const dow = m.day(); // 0=Sunday, 6=Saturday

                    // Mode mapping
                    // 0 -> No weekly off (all days working)
                    // 1 -> All Sundays off
                    // 2 -> All Sundays and Saturdays off
                    // 3 -> All Sundays and (2nd & 4th Saturdays)
                    // 4 -> All Sundays and alternate Saturdays (1st,3rd,5th)
                    if ( mode === '0' ) return callback( null, { off: false } );
                    if ( dow === 0 ) return callback( null, { off: true, type: 'weekly', mode } );

                    if ( dow === 6 )
                    {
                        const dom = m.date();
                        const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1; // 1-based
                        if ( mode === '2' ) return callback( null, { off: true, type: 'weekly', mode } );
                        if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) return callback( null, { off: true, type: 'weekly', mode } );
                        if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) return callback( null, { off: true, type: 'weekly', mode } );
                    }

                    return callback( null, { off: false } );
                } ).catch( ( err3 ) => callback( err3 ) );
            } );
        } );
    } );
}

/**
 * Promise wrapper for checkIfDateIsOff
 */
function checkIfDateIsOffAsync ( date )
{
    return new Promise( ( resolve, reject ) =>
    {
        checkIfDateIsOff( date, ( err, res ) =>
        {
            if ( err ) return reject( err );
            resolve( res || { off: false } );
        } );
    } );
}

/**
 * Check a date range for off-days
 */
async function checkRangeForOffDates ( startD, endD )
{
    const found = [];
    try
    {
        let cursor = moment( startD, 'YYYY-MM-DD' );
        const last = moment( endD, 'YYYY-MM-DD' );
        while ( cursor.isSameOrBefore( last, 'day' ) )
        {
            const dt = cursor.format( 'YYYY-MM-DD' );
            const info = await checkIfDateIsOffAsync( dt );
            if ( info && info.off )
            {
                found.push( { date: dt, info } );
            }
            cursor.add( 1, 'day' );
        }
    }
    catch ( e )
    {
        console.error( 'Error checking range for off dates:', e );
    }
    return found;
}

module.exports = {
    checkIfDateIsOff,
    checkIfDateIsOffAsync,
    checkRangeForOffDates
};
