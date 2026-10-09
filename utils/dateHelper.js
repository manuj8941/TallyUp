const moment = require( 'moment-timezone' );
const { getMoment } = require( '../db/timezone' );

function formatTimeForDisplay ( date, time )
{
    if ( !date || !time ) return null;
    return moment( `${ date } ${ time }`, 'YYYY-MM-DD HH:mm:ss' ).format( 'h:mm A' );
}

function computeTotalTimeForRow ( row )
{
    if ( !row || !row.in_time ) return null;
    try
    {
        const inMoment = moment( `${ row.date } ${ row.in_time }`, 'YYYY-MM-DD HH:mm:ss' );
        const outMoment = row.out_time ? moment( `${ row.date } ${ row.out_time }`, 'YYYY-MM-DD HH:mm:ss' ) : getMoment();
        const diff = moment.duration( outMoment.diff( inMoment ) );
        if ( diff.asMilliseconds() <= 0 ) return null;
        const hours = Math.floor( diff.asHours() );
        const minutes = diff.minutes();
        return `${ hours }h ${ minutes }m`;
    } catch ( e )
    {
        return null;
    }
}

function formatDateForDisplay ( date )
{
    if ( !date ) return null;
    // Compact date for tables: e.g. 6-Dec-25
    return moment( date, 'YYYY-MM-DD' ).format( 'D-MMM-YY' );
}

function getCookieValue ( req, name )
{
    const header = req.headers && req.headers.cookie;
    if ( !header ) return null;
    const pairs = header.split( ';' ).map( p => p.trim() );
    for ( const p of pairs )
    {
        const parts = p.split( '=' );
        if ( parts[ 0 ] === name ) return decodeURIComponent( parts.slice( 1 ).join( '=' ) );
    }
    return null;
}

function isRequestMobile ( req )
{
    // Preferred: client sets cookie `device_type=mobile|desktop` via client-side JS
    const cookieVal = getCookieValue( req, 'device_type' );
    if ( cookieVal ) return cookieVal === 'mobile';

    // Fallback to UA sniffing (best-effort)
    const ua = ( req.headers && req.headers[ 'user-agent' ] ) || '';
    return /Mobi|Android|iPhone|iPad|Windows Phone/i.test( ua );
}

// Helper: return an effective 'today' (YYYY-MM-DD) for the request.
// Priority: global override > query param `test_date` > header `x-test-date` > cookie `test_date` > session.testDate > system date.
function getEffectiveDate ( req )
{
    try
    {
        // 0) global app-wide override (owner-set permanent test date)
        if ( req && req.app && req.app.locals && req.app.locals.testDateOverride )
        {
            const m = moment( req.app.locals.testDateOverride, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }
        // 1) query param
        if ( req && req.query && req.query.test_date )
        {
            const m = moment( req.query.test_date, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 2) header
        if ( req && req.headers && req.headers[ 'x-test-date' ] )
        {
            const m = moment( req.headers[ 'x-test-date' ], 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 3) cookie
        const cookieVal = getCookieValue( req, 'test_date' );
        if ( cookieVal )
        {
            const m = moment( cookieVal, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 4) session override (useful for scripted tests)
        if ( req && req.session && req.session.testDate )
        {
            const m = moment( req.session.testDate, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }
    } catch ( e ) { /* ignore and fall back to real date */ }
    return getMoment().format( 'YYYY-MM-DD' );
}

module.exports = {
    formatTimeForDisplay,
    computeTotalTimeForRow,
    formatDateForDisplay,
    getCookieValue,
    isRequestMobile,
    getEffectiveDate
};
