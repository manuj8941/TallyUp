const { getSetting } = require( '../db/settings' );
const { isRequestMobile } = require( '../utils/dateHelper' );

function enforceDeviceAccess ( req, res, next )
{
    // Only enforce for authenticated non-owner users. Let unauthenticated requests pass (so owner can login).
    if ( !req.session || !req.session.user || req.session.user.role === 'owner' ) return next();

    // Check current app-wide desktop flag
    getSetting( 'desktop_enabled' ).then( ( value ) =>
    {
        const enabled = value || '1';
        if ( enabled === '1' ) return next();

        // desktop access is disabled; if request is from a desktop browser, block
        const isMobile = isRequestMobile( req );
        if ( isMobile ) return next();

        // Block desktop user (non-owner)
        // If it's an API/JSON request, return JSON; otherwise destroy session and redirect to login
        const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
        if ( acceptsJson || req.xhr )
        {
            return res.status( 403 ).json( { error: 'Hey there! 👋 For security, please sign in from your mobile device. Desktop access is currently disabled.' } );
        }

        // Destroy session and redirect to login with a flag so the UI can show a friendly message
        req.session.destroy( () =>
        {
            return res.redirect( '/?desktop_blocked=1' );
        } );
    } ).catch( ( err ) =>
    {
        console.error( 'Error reading desktop_enabled setting', err && err.message );
        return next();
    } );
}

module.exports = {
    enforceDeviceAccess
};
